#!/usr/bin/env node
/**
 * fetch-data.mjs
 * 从 PRTS Wiki 抓取明日方舟寻访（卡池）数据，解析 wikitext 并生成静态 JSON。
 *
 * 输出（data/，本仓库根目录下的 data 目录）：
 *   operators.json         以 charId 为键的干员表（仅 5★/6★）
 *                          含 scReleaseDate（国服实装日）/ enReleaseDate / tcReleaseDate
 *   banners_sc.json        国服卡池表（以卡池 ID 为键；en / tc 两个分文件
 *                          由各自的脚本产出，本脚本只读 banners_en.json 用于反查英文名）
 *                          每个卡池都有 `name` / `scName` / `enName` 三个名字字段：
 *                          `scName` = 国服中文名（本脚本的 name 就是它）；
 *                          `enName` = 国际服英文名，按干员集合反查 banners_en.json，
 *                                     没有英文名的（带序号的池子三服同名）为 null。
 *                          详见 scripts/lib/banner-names.mjs
 *                          另有 `actType` / `actName`（所属活动）与 —— **只给单六寻访的** ——
 *                          `canRerun` / `rerunKind`，见文件末尾那段说明。
 *   metadata.json          元信息（含服务器列表）
 *
 * ⚠️ 不再输出 `banner-categories.json`：type → 大类的映射已移入站点侧
 *    `akGachaData/src/lib/constants.js` 的 `BANNER_CATEGORIES`。
 *
 * 限定寻访会细分为 limcel（庆典）/ limspr（春节）/ limsum（夏季），见 `limitedSubtype()`；
 * **ID 里的类型段与 `type` 一致**（2026-10-01 起，此前限定池的 ID 一律写 `limited`）。
 *
 * ⚠️ **卡池所属活动（`actType` / `canRerun`）只在带 `--with-activities` 时去抓**
 *    （CI 里只有**周五**那一轮带，见 .github/workflows/update-data.yml；手动触发一律带）——
 *    活动类型变化很慢，没必要每次跑都花那 ~7 次请求。
 *    **不抓的那几次必须从旧文件回填**（见 main 里 else 那支），否则重写会把字段抹掉。
 *    口径、实测与两个解析坑见 akGachaDocs/resource/单六寻访活动类型与复刻预研.md。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pinyin } from 'pinyin-pro';
import { metaStable, orderMeta } from './lib/meta.mjs';
import { buildNameIndex, countNameGroups, createNameMatcher, nameGroupOf } from './lib/banner-names.mjs';
import './lib/http.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'data');

/* 服务器：本脚本只负责**国服**（PRTS Wiki）。国际服见 fetch-data-en.mjs（wiki.gg）、
   繁中服见 fetch-data-tc.mjs（金山文档 AirScript）。
   卡池按服务器分文件（banners_sc.json / banners_en.json / banners_tc.json），
   干员表共用一份，靠 *ReleaseDate 字段区分各服实装日。 */
const DEFAULT_SERVER = 'sc';
const SERVERS = [
  { id: 'sc', label: '国服', available: true },
  { id: 'en', label: '国际服', available: false },
  { id: 'tc', label: '繁中服', available: false },
];

/** 国服这三个数据来源页（写进 metadata.sourcePages）；其余来源由各自脚本追加 */
const CN_SOURCE_PAGES = [
  '卡池一览/常驻标准寻访',
  '卡池一览/限时寻访',
  '寻访规则',
  // ⚠️ 「卡池一览/常驻中坚寻访&中坚甄选」2026-10-06 起不再作为来源 ——
  //    中坚改由官方解包数据提供，见 scripts/fetch-gamedata.mjs
];

/** ⚠️ **已停用**的来源页：旧 metadata 里可能还留着，写回时要**主动滤掉**（见 sourcePages 那段） */
const RETIRED_SOURCE_PAGES = ['卡池一览/常驻中坚寻访&中坚甄选'];

const API = 'https://prts.wiki/api.php';

// ---------------------------------------------------------------- 通用请求

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  Referer: 'https://prts.wiki/',
  Origin: 'https://prts.wiki',
};

/* 限定寻访细分为三类（用户要求）：
   庆典 limcel / 春节 limspr / 夏季 limsum
   依据是 wiki 链接文案里的【限定寻访·庆典】这类标记（rowText 里拿得到），
   统计结果：庆典 13 / 春节 8 / 夏季 6。
   万一以后 wiki 改版没了标记，就按起始月份兜底（5、11 月 = 庆典，1-2 月 = 春节，8 月 = 夏季）。 */
const LIM_SUBTYPE = { 庆典: 'limcel', 春节: 'limspr', 夏季: 'limsum' };

function limitedSubtype(rowText, startDate) {
  const m = String(rowText).match(/限定寻访[·・](庆典|春节|夏季)/);
  if (m) return LIM_SUBTYPE[m[1]];
  const mm = Number(String(startDate).slice(5, 7));
  if (mm === 1 || mm === 2) return 'limspr';
  if (mm === 8) return 'limsum';
  return 'limcel';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function requestJson(params, { tries = 5, method = 'GET' } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      let res;
      if (method === 'POST') {
        res = await fetch(API, {
          method: 'POST',
          headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(params),
        });
      } else {
        res = await fetch(`${API}?${new URLSearchParams(params)}`, { headers: HEADERS });
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(`API error: ${json.error.info || JSON.stringify(json.error)}`);
      return json;
    } catch (e) {
      lastErr = e;
      /* ⚠️ undici 抛的 "fetch failed" 本身毫无信息量，真正的原因在 e.cause
         （ECONNRESET / ENOTFOUND / TLS 握手失败 / Cloudflare 拦截 …）。
         在 CI 里排查网络问题时这一行是关键，别删。 */
      const c = e && e.cause;
      const detail = c ? `${c.code || c.name || ''} ${c.message || ''}`.trim() : '';
      console.error(`  · 第 ${i + 1}/${tries} 次请求失败: ${e.message}${detail ? ' ← ' + detail : ''}`);
      await sleep(1200 * (i + 1));
    }
  }
  const c = lastErr && lastErr.cause;
  const tail = c ? `${c.code || c.name || ''} ${c.message || ''}`.trim() : '';
  throw new Error(`请求失败 (${method} ${JSON.stringify(params).slice(0, 160)}): `
    + `${lastErr && lastErr.message}${tail ? ' ← ' + tail : ''}`);
}

/** Cargo 查询（自动分页） */
async function cargoQuery({ tables, fields, join_on, where }) {
  const rows = [];
  const limit = 500;
  for (let offset = 0; ; offset += limit) {
    const params = { action: 'cargoquery', tables, fields, format: 'json', limit, offset };
    if (join_on) params.join_on = join_on;
    if (where) params.where = where;
    const json = await requestJson(params);
    const page = (json.cargoquery || []).map((r) => r.title);
    rows.push(...page);
    if (page.length < limit) break;
    if (offset > 10000) break; // 安全阀
  }
  return rows;
}

/** 取页面 wikitext */
async function fetchWikitext(titles) {
  const json = await requestJson({
    action: 'query',
    prop: 'revisions',
    titles: Array.isArray(titles) ? titles.join('|') : titles,
    rvprop: 'content',
    rvslots: 'main',
    format: 'json',
    formatversion: 2,
  });
  const out = {};
  for (const p of json.query.pages) {
    if (p.revisions) out[p.title] = p.revisions[0].slots.main.content;
    else console.warn(`  ! 页面不存在: ${p.title}`);
  }
  return out;
}

/** 同 `fetchWikitext`，但**跟重定向** —— 活动页里有 `#REDIRECT`（如 `火蓝之心复刻` → `火蓝之心2020`），
    不带 `redirects` 只会拿到 `#REDIRECT [[…]]` 那段文本、解析不出任何字段。
    ⚠️ 跟着重定向后，返回的键是**目标页标题**（这正是我们要的）。 */
async function fetchRedirectedWikitext(titles) {
  const out = {};
  for (let i = 0; i < titles.length; i += 50) {
    const json = await requestJson({
      action: 'query',
      prop: 'revisions',
      titles: titles.slice(i, i + 50).join('|'),
      rvprop: 'content',
      rvslots: 'main',
      redirects: 1,
      format: 'json',
      formatversion: 2,
    });
    for (const p of json.query?.pages || []) {
      if (p.revisions) out[p.title] = p.revisions[0].slots.main.content;
    }
    await sleep(150);
  }
  return out;
}

// ------------------------------------------------- 卡池所属活动（2026-10-05 加）

/* 用途：判断**单六寻访会不会复刻** —— 实测只跟「所属活动的类型」有关：
   `type === 'single'` 的首发池里，「非支线故事」的 25 个**一个都没复刻过**（0 反例），
   支线故事的有 23/28 复刻过。口径与实测见
   akGachaDocs/resource/单六寻访活动类型与复刻预研.md。
   数据源：活动页的 `{{活动信息}}` 模板 —— 里面既有 `类型`，又有 `限时寻访N`
   （**直接列出同期卡池**，所以「卡池 ↔ 活动」不用靠日期去猜）。 */

const ACTIVITY_CATEGORY = '分类:有活动信息的页面';

/** 已知反例（用户 2026-10-05 确认「理论上不会有新的」，所以直接写死在代码里）：
    活动是支线故事、但**确实没复刻**的两个池 —— 2019「火蓝之心」在 2020 复刻时带了新干员
    （棘刺）、开的是新池「不羁逆流」，当年这两个旧池就没复刻。 */
const CAN_RERUN_EXCEPTIONS = new Set(['深夏的守夜人', '久铸尘铁']);

/** 卡池名归一化，用于比对：**只留字母 / 数字 / 汉字**，去掉一切符号与空格。
    实测 432 个卡池名归一化后仍是 432 个不同键（**零碰撞**），而能多收回
    「燃钢之心:暴躁铁皮 复刻」这种全角/半角冒号不一致的（覆盖率 74 → 75 / 84）。 */
const normName = (s) => String(s || '').replace(/[^\p{L}\p{N}]/gu, '');

/** 解析 `{{活动信息}}` → 活动类型 / 开始日 / 它列出的同期卡池名 */
function parseActivityInfo(text) {
  const s = String(text);
  const i = s.indexOf('{{活动信息');
  if (i < 0) return null;
  const end = s.indexOf('\n}}', i);
  const body = s.slice(i + '{{活动信息'.length, end < 0 ? undefined : end);
  const p = {};
  for (const line of body.split('\n')) {
    const m = /^\|([^=]+)=(.*)$/.exec(line.trim());
    if (m) p[m[1].trim()] = m[2].trim();
  }
  const gachas = [];
  for (const k of Object.keys(p)) {
    if (!/^限时寻访\d*$/.test(k)) continue;
    const val = String(p[k] || '').trim();
    if (!val) continue;
    const links = [...val.matchAll(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g)];
    if (!links.length) { gachas.push(val); continue; }
    for (const m of links) {
      /* ⚠️ 链接的**目标**才是真名：`[[寻访模拟/搅动潮汐之剑 复刻|搅动潮汐之剑]]` 里
         显示名反而是**原池名**。两个都收（比对照样按归一化，不会误配）。 */
      gachas.push(m[1].replace(/^寻访模拟\//, '').trim());
      if (m[2]) gachas.push(m[2].trim());
    }
  }
  return { type: p['类型'] || null, startDate: toDate(p['活动开始时间']), gachas: gachas.filter(Boolean) };
}

/** 活动页 → `归一化卡池名 → { actType, actName, actStartDate }` */
async function fetchActivityMap() {
  const titles = [];
  let cont = {};
  do {
    const j = await requestJson({
      action: 'query',
      list: 'categorymembers',
      cmtitle: ACTIVITY_CATEGORY,
      cmlimit: 500,
      format: 'json',
      formatversion: 2,
      ...cont,
    });
    for (const m of j.query?.categorymembers || []) titles.push(m.title);
    cont = j.continue || {};
  } while (cont.cmcontinue);

  const pages = await fetchRedirectedWikitext(titles);
  const map = {};
  let parsed = 0;
  for (const [title, text] of Object.entries(pages)) {
    const info = parseActivityInfo(text);
    if (!info) continue;
    parsed += 1;
    for (const name of info.gachas) {
      const key = normName(name);
      if (!key) continue;
      const prev = map[key];
      /* 同一个池名可能同时出现在**首发**活动页与**复刻**活动页 → 取**活动开始日最早**的（= 首发活动）。 */
      if (!prev || (info.startDate && (!prev.actStartDate || info.startDate < prev.actStartDate))) {
        map[key] = { actType: info.type, actName: title, actStartDate: info.startDate };
      }
    }
  }
  return { map, pageCount: titles.length, parsed };
}

// ---------------------------------------------------------------- 工具函数

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 北京时间下的今天 YYYY-MM-DD */
function todayBeijing() {
  const t = new Date(Date.now() + BEIJING_OFFSET_MS);
  return t.toISOString().slice(0, 10);
}

/** 只取 YYYY-MM-DD */
function toDate(str) {
  const m = /(\d{4}-\d{2}-\d{2})/.exec(str || '');
  return m ? m[1] : null;
}

/** 从时间区间文本里取出 [start, end] */
function parseTimeRange(text) {
  const dates = [...String(text).matchAll(/(\d{4}-\d{2}-\d{2})/g)].map((m) => m[1]);
  if (dates.length === 0) return [null, null];
  return [dates[0], dates[1] || dates[0]];
}

/** 汉字 -> 拼音首字母，过滤掉非汉字字符 */
function pinyinInitials(str) {
  const han = String(str).replace(/[^\u4e00-\u9fa5]/g, '');
  if (!han) return '';
  return pinyin(han, { pattern: 'first', toneType: 'none', type: 'array' }).join('').toLowerCase();
}

const pad4 = (n) => String(n).padStart(4, '0');

// ---------------------------------------------------------------- wikitext 解析

/** 把一个 wikitext 表格拆成「行」（忽略嵌套表格里的 |-） */
function parseTableRows(content) {
  const lines = content.split('\n');
  const rows = [];
  let depth = 0;
  let base = null;
  let cur = null;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('{|')) {
      depth += 1;
      if (base === null) base = depth;
      if (cur) cur.push(line);
      continue;
    }
    if (t.startsWith('|}')) {
      depth -= 1;
      if (cur) cur.push(line);
      continue;
    }
    if (base !== null && depth === base && t.startsWith('|-')) {
      if (cur) rows.push(cur);
      cur = [];
      continue;
    }
    if (cur) cur.push(line);
  }
  if (cur) rows.push(cur);
  return rows.filter((r) => r.length > 0);
}

/** 把一行的原始文本拆成单元格 */
function parseCells(rowLines) {
  const cells = [];
  let depth = 0;
  for (const line of rowLines) {
    const t = line.trim();
    if (t.startsWith('{|')) {
      depth += 1;
      if (cells.length) cells[cells.length - 1].push(line);
      continue;
    }
    if (t.startsWith('|}')) {
      depth -= 1;
      if (cells.length) cells[cells.length - 1].push(line);
      continue;
    }
    if (depth === 0 && t.startsWith('|') && !t.startsWith('|-')) {
      let body = t.slice(1);
      const p = body.indexOf('|');
      if (p !== -1 && body.slice(0, p).includes('=')) body = body.slice(p + 1);
      cells.push([body]);
      continue;
    }
    if (cells.length) cells[cells.length - 1].push(line);
  }
  return cells.map((c) => c.join('\n'));
}

const AVATAR_RE = /\{\{\s*干员头像\s*\|([^}]*)\}\}/g;

/** 从一个单元格里抽取 {{干员头像|名字|参数}} */
function extractAvatars(cellText) {
  const result = [];
  for (const m of String(cellText).matchAll(AVATAR_RE)) {
    const parts = m[1].split('|').map((s) => s.trim());
    const name = parts.shift();
    if (!name) continue;
    const args = {};
    for (const p of parts) {
      if (!p) continue;
      const eq = p.indexOf('=');
      if (eq === -1) args[p] = true;
      else args[p.slice(0, eq).trim()] = p.slice(eq + 1).trim();
    }
    result.push({ name, args });
  }
  return result;
}

const isShopArg = (args) => Boolean(args.shop || args.shop2);

/** 取单元格里最后一个 [[链接]] 的显示名 */
function lastLinkText(cellText) {
  const links = [...String(cellText).matchAll(/\[\[([^\[\]]+)\]\]/g)].map((m) => m[1]);
  if (!links.length) return null;
  const last = links[links.length - 1];
  const idx = last.indexOf('|');
  return (idx === -1 ? last : last.slice(idx + 1)).trim();
}

/** 把 wikitext 标题归一化：去掉命名空间前缀与图片扩展名 */
function baseTitle(t) {
  const s = String(t).trim();
  const cut = Math.max(s.lastIndexOf('/'), s.lastIndexOf(':'));
  const base = cut === -1 ? s : s.slice(cut + 1);
  return base.replace(/\.(jpg|jpeg|png|gif|webp)$/i, '');
}

/**
 * 从卡池单元格里提取「真实序号」。
 * 依次尝试：链接目标 / 显示文本 / link= 参数 / 文件名的末尾数字。
 * 例：[[文件:一周年联合行动.jpg|…|link=寻访模拟/联合行动02]] → 02
 */
function serialFromCell(cellText) {
  const titles = [];
  for (const m of String(cellText).matchAll(/\[\[([^\[\]]+)\]\]/g)) {
    const raw = m[1];
    const idx = raw.indexOf('|');
    titles.push(idx === -1 ? raw : raw.slice(0, idx));
    if (idx !== -1) titles.push(raw.slice(idx + 1));
  }
  for (const m of String(cellText).matchAll(/link=([^|\]\n]+)/g)) titles.push(m[1]);
  for (const t of titles) {
    const digits = /(\d+)$/.exec(baseTitle(t));
    if (digits) return digits[1];
  }
  return null;
}

/** 从甄选/跨年这类嵌套表格里拆出 6★ 与 5★ 候选列表 */
function parseSelectionCell(rowText) {
  const idx6 = rowText.indexOf('可甄选6★干员');
  const idx5 = rowText.indexOf('可甄选5★干员');
  if (idx6 === -1 || idx5 === -1) return { six: [], five: [] };
  return {
    six: extractAvatars(rowText.slice(idx6, idx5)),
    five: extractAvatars(rowText.slice(idx5)),
  };
}

// ---------------------------------------------------------------- 数据抓取

/** 干员：char_obtain 关联 chara。
 *  星级只查到 4★（rarity 0 起：3=4★、4=5★、5=6★）—— 同一份 rows 既出干员表
 *  （obtainMethod 命中三类寻访 + 5/6★），也当卡池解析的星级表用（剔 4★ / opMeta 兜底），
 *  不再单独查全稀有度的 chara 表。
 *  ⚠️ obtainMethod 条件覆盖到 4★ 才安全：2026-10-03 实测，出现在卡池单元格里的
 *     53 条 4★ 记录 obtainMethod 全是「公开招募 标准寻访 中坚寻访」，LIKE 均命中。
 *     万一将来有不匹配的 4★ 进了单元格，它查不到星级、会按列位置 fallback 成 5/6★
 *     留下，并触发「出现未知干员」警告 —— 看到这条警告就回来放宽这里的 where。 */
async function fetchOperators() {
  console.log('· 抓取干员列表 ...');
  const rows = await cargoQuery({
    tables: 'char_obtain=CO,chara=C',
    fields:
      'CO._pageName=page,CO.cnOnlineTime=cnOnlineTime,CO.obtainMethod=obtainMethod,C.charId=charId,C.rarity=rarity',
    join_on: 'CO._pageName=C._pageName',
    where: "C.rarity IN (3,4,5) AND (CO.obtainMethod LIKE '%标准寻访%' "
      + "OR CO.obtainMethod LIKE '%限定寻访%' OR CO.obtainMethod LIKE '%中坚寻访%')",
  });

  return { rows };
}

/** 进入中坚寻访的日期（寻访规则 第 5 节） */
async function fetchClassicDates() {
  console.log('· 抓取寻访规则（中坚移出批次）...');
  const json = await requestJson({
    action: 'parse',
    page: '寻访规则',
    prop: 'wikitext',
    section: 5,
    format: 'json',
    formatversion: 2,
  });
  const wikitext = json.parse.wikitext;
  const map = new Map();

  // 每个批次：移出时间 + 6★/5★ 列表
  const blocks = wikitext.split(/\{\|/).filter((b) => b.includes('移出时间'));
  for (const block of blocks) {
    const date = toDate(/移出时间：?\s*([\d-]+)/.exec(block)?.[1] || '');
    if (!date) continue;
    for (const m of block.matchAll(/[\u2605]{5,6}\s*\n\|([^\n]+)/g)) {
      for (const name of m[1].split('/').map((s) => s.trim())) {
        if (name) map.set(name, date);
      }
    }
  }
  console.log(`  → 批次干员 ${map.size} 位`);
  return map;
}

/** 卡池页：index -> 各年度子页 */
async function fetchBannerPages() {
  console.log('· 抓取卡池页面 ...');
  const out = {};

  /* ⚠️ 只抓「常驻标准寻访」这个索引页 —— 「常驻中坚寻访&中坚甄选」**2026-10-06 起不再抓**
     （中坚已改由官方解包提供，理由见下面 classic / clafes 那段注释）。 */
  const indexPages = ['卡池一览/常驻标准寻访'];
  const index = await fetchWikitext(indexPages);
  const subPages = [];
  for (const [title, content] of Object.entries(index)) {
    const names = [...content.matchAll(/pageName=([^|}\n]*)/g)]
      .map((m) => m[1].trim())
      .filter(Boolean);
    out[title] = { isIndex: true, subPages: names };
    subPages.push(...names);
  }

  // 年度子页分两批抓取，避免单次请求过长
  for (let i = 0; i < subPages.length; i += 4) {
    Object.assign(out, await fetchWikitext(subPages.slice(i, i + 4)));
    await sleep(250);
  }

  Object.assign(out, await fetchWikitext('卡池一览/限时寻访'));
  return out;
}

// ---------------------------------------------------------------- 组装卡池

/** 带真实序号的固定系列卡池，展示名用「系列名 + 序号（不补零）」 */
const SEQ_PREFIX = {
  joint: '联合行动',
  stdfes: '定向甄选',
  mainfes: '前路回响',
};

/**
 * ⚠️ 以前这里有个 `CATEGORIES`（type → 大类）并输出成 `banner-categories.json`。
 * 现已删除：该映射与服务器无关、也不随数据更新，没必要当数据文件分发，
 * 已并入站点侧的 `akGachaData/src/lib/constants.js` 的 `BANNER_CATEGORIES`。
 * **别再把它加回来** —— 否则跟站点常量会两处维护、容易走样。
 */

/** 由各卡池页面构建卡池列表
 *  @param opMeta (name) => { stars, scReleaseDate } —— 用于判断「首次 UP」（实装日期 == 卡池开始日期） */
function buildBanners(pages, opMeta) {
  const banners = [];
  const warnings = [];

  const metaOf = (n) => (opMeta ? opMeta(n) : { stars: 0, scReleaseDate: null });

  /** 5★ 恰好两位、且都在本卡池首次 UP（即实装日期 == 卡池开始日期）→「双五寻访」 */
  const isDoubleNewFive = (rawOps, startDate) => {
    const fives = rawOps.filter((a) => metaOf(a.name).stars === 5);
    return fives.length === 2 && fives.every((a) => metaOf(a.name).scReleaseDate === startDate);
  };

  const pickOps = (cells, sixIdx, fiveIdx) => {
    const six = extractAvatars(cells[sixIdx] || '');
    const five = extractAvatars(cells[fiveIdx] || '');
    return [...six, ...five].map((a) => ({ ...a, col: six.includes(a) ? 6 : 5 }));
  };

  // ---- 常驻标准寻访 -> double
  const stdIndex = pages['卡池一览/常驻标准寻访'];
  for (const sub of stdIndex.subPages) {
    const content = pages[sub];
    if (!content) continue;
    for (const row of parseTableRows(content)) {
      const cells = parseCells(row);
      if (cells.length < 5) continue;
      const serial = cells[0].replace(/\s+/g, '');
      if (!/^\d+$/.test(serial)) continue;
      const [startDate, endDate] = parseTimeRange(cells[2]);
      if (!startDate) continue;
      banners.push({
        id: `${startDate.replace(/-/g, '')}_double_${pad4(serial)}`,
        name: `常驻标准寻访${Number(serial)}`,
        type: 'double',
        startDate,
        endDate,
        rawOps: pickOps(cells, 3, 4),
      });
    }
  }

  /* ---- 常驻中坚寻访 & 中坚甄选：**2026-10-06 起不再从 PRTS 抓** ----
     改由**官方解包数据**提供 → `scripts/fetch-gamedata.mjs` 产出 `data/banners_cla_<server>.json`，
     站点侧（`loadData.js`）合并。原因见 `akGachaDocs/resource/官方解包数据（ArknightsGamedata）预研.md`：
     wiki 的中坚数据会**漏写**（中坚甄选少一个六星）也会**记错进店位**，而官方解包有完整的
     干员名单 + 明确的进店位（`main6RarityCharId` / `rare5CharList[0]`），且三服都有。
     ⚠️ 连带两处也改了：上面 `indexPages` 里已移除那个索引页（所以本函数不再抓它的子页）；
     `CN_SOURCE_PAGES` 里也去掉了它。
     ⚠️ 但「寻访规则」页**仍要抓** —— `classicDate`（干员转入中坚的批次）来自那里，见 `fetchClassicDates()`。 */

  // ---- 限时寻访 -> limited / joint / stdfes / mainfes / single / five
  const limitedContent = pages['卡池一览/限时寻访'];
  if (!limitedContent) throw new Error('缺少 卡池一览/限时寻访 页面');

  const sections = splitSections(limitedContent);
  for (const [sectionName, content] of sections) {
    const isNonStandard = sectionName.includes('非标准寻访');
    for (const row of parseTableRows(content)) {
      const cells = parseCells(row);
      if (cells.length < 3) continue;
      const linkCell = cells[0];
      const [startDate, endDate] = parseTimeRange(cells[1]);
      if (!startDate) continue;
      const name = lastLinkText(linkCell);
      if (!name) {
        warnings.push(`限时寻访缺少名称: ${linkCell.slice(0, 60)}`);
        continue;
      }
      const rowText = row.join('\n');
      const isSelection = rowText.includes('可甄选6★干员');
      const datePart = startDate.replace(/-/g, '');

      if (isNonStandard) {
        // 限定寻访以外（联动 / 跨年欢庆）一律排除
        if (!name.includes('限定寻访')) continue;
        const bannerName = name.replace(/【[^】]*】/g, '').trim() || name;
        const initials = pinyinInitials(bannerName);
        /* 类型段与 type 保持一致（limcel / limspr / limsum）——
           2026-10-01 之前这里一律写 `limited`，与细分后的 type 不一致，容易误判。 */
        const type = limitedSubtype(rowText, startDate);
        banners.push({
          id: `${datePart}_${type}_${initials}`,
          name: bannerName,
          type,
          startDate,
          endDate,
          rawOps: pickOps(cells, 2, 3),
        });
      } else {
        const sel = isSelection ? parseSelectionCell(rowText) : null;
        const rawOps = isSelection
          ? [
              ...sel.six.map((a) => ({ ...a, col: 6 })),
              ...sel.five.map((a) => ({ ...a, col: 5 })),
            ]
          : pickOps(cells, 2, 3);
        const sixCount = rawOps.filter((a) => a.col === 6).length;

        // 带序号的固定系列：序号取卡池页面名里的「真实序号」（不补零用于展示，补零用于 ID）
        const seqType = name.includes('联合行动')
          ? 'joint'
          : name.includes('定向甄选')
            ? 'stdfes'
            : name.includes('前路回响')
              ? 'mainfes'
              : null;

        let type;
        let serial = null;
        if (seqType) {
          type = seqType;
          const fromCell = serialFromCell(linkCell);
          const fromName = /(\d+)/.exec(name)?.[1] ?? null;
          serial = Number(fromCell ?? fromName ?? 0);
        } else if (isDoubleNewFive(rawOps, startDate)) {
          // 双五寻访：两位 5★ 均为本池首次 UP
          type = 'five';
        } else if (sixCount === 1) {
          // 单六寻访：仅 1 个六星 UP
          type = 'single';
        } else if (sixCount === 0) {
          type = 'five';
        } else {
          warnings.push(`限时寻访标准池类型未识别（${sixCount} 个六星）: ${name} ${startDate}`);
          type = 'joint';
          serial = 0;
        }

        const isSeq = type === 'joint' || type === 'stdfes' || type === 'mainfes';
        const suffix = isSeq ? pad4(serial) : pinyinInitials(name);
        banners.push({
          id: `${datePart}_${type}_${suffix}`,
          name: isSeq ? `${SEQ_PREFIX[type]}${serial}` : name,
          type,
          startDate,
          endDate,
          rawOps,
        });
      }
    }
  }

  // 去重 & 排序
  const seen = new Map();
  for (const b of banners) {
    if (seen.has(b.id)) {
      warnings.push(`卡池 ID 重复（已跳过）: ${b.id} / ${b.name} / ${b.startDate}`);
      continue;
    }
    seen.set(b.id, b);
  }
  const list = [...seen.values()].sort((a, b) =>
    a.startDate === b.startDate ? a.id.localeCompare(b.id) : a.startDate.localeCompare(b.startDate),
  );
  return { list, warnings };
}

/** 按 ==标题== 切分页面内容 */
function splitSections(content) {
  const lines = content.split('\n');
  const sections = [];
  let title = '__lead__';
  let buf = [];
  for (const line of lines) {
    const m = /^==\s*([^=]+?)\s*==\s*$/.exec(line.trim());
    if (m) {
      sections.push([title, buf.join('\n')]);
      title = m[1];
      buf = [];
      continue;
    }
    buf.push(line);
  }
  sections.push([title, buf.join('\n')]);
  return sections;
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const [operatorData, classicMap, pages] = await Promise.all([
    fetchOperators(),
    fetchClassicDates(),
    fetchBannerPages(),
  ]);

  /* ---- 读旧文件：本脚本**不负责**国际服字段 ----
     国际服数据由 `fetch-data-en.mjs` 产出（enName / enReleaseDate / enClassicDate
     以及 banners_en.json）。本脚本只重建国服部分，所以要把这些**原样保留**，
     否则跑一次 build:data 就会把国际服数据抹掉。
     同理 metadata 里非默认服务器的 available / bannerCount 也由 en 脚本负责。 */
  const readPrev = async (name) => {
    try { return JSON.parse(await fs.readFile(path.join(OUT_DIR, name), 'utf8')); } catch { return null; }
  };
  const prevOperators = (await readPrev('operators.json')) || {};
  const prevMeta = (await readPrev('metadata.json')) || { servers: [] };

  // 姓名 -> 星级（4-6★）：供卡池解析剔 4★ / opMeta 兜底。
  // 与干员列表同源（rows，注意中文名字段是 page 不是 name），
  // 1-3★ 不查 —— 它们永远不会出现在卡池单元格里。
  const rarityByName = new Map();
  const obtainByName = new Map();
  for (const c of operatorData.rows) {
    const stars = Number(c.rarity || 0) + 1;
    if (!rarityByName.has(c.page)) rarityByName.set(c.page, stars);
    if (!obtainByName.has(c.page)) obtainByName.set(c.page, c.obtainMethod || '');
  }
  console.log(`· 干员星级表（4-6★）${rarityByName.size} 条`);

  // 干员表：obtainMethod 命中三类寻访且星级 >= 5
  const operators = {};
  const obtainByChar = new Map();
  for (const row of operatorData.rows) {
    if (!row.charId) continue;
    if (!obtainByChar.has(row.charId)) obtainByChar.set(row.charId, row);
  }
  let skippedNoRarity = 0;
  for (const [charId, row] of obtainByChar) {
    const obtainMethod = row.obtainMethod || '';
    if (!/标准寻访|中坚寻访|限定寻访/.test(obtainMethod)) continue;
    const stars = Number(row.rarity || 0) + 1;
    if (stars < 5) continue;
    const scReleaseDate = toDate(row.cnOnlineTime);
    if (!scReleaseDate) {
      skippedNoRarity += 1;
      continue;
    }
    const prev = prevOperators[charId] || {};
    operators[charId] = {
      name: row.page,
      enName: prev.enName ?? null,            // 国际服名字（由 fetch-data-en.mjs 填）
      charId,
      rarity: stars,
      scReleaseDate,                          // 国服实装日
      enReleaseDate: prev.enReleaseDate ?? null,  // 国际服实装日（同上）
      tcReleaseDate: prev.tcReleaseDate ?? null,  // 繁中服实装日（由 fetch-data-tc.mjs 填）
      obtainMethod,
      isLimited: /限定寻访/.test(obtainMethod),
      classicDate: classicMap.get(row.page) || null,
      enClassicDate: prev.enClassicDate ?? null,  // 国际服进入中坚寻访的日期（同上）
      tcClassicDate: prev.tcClassicDate ?? null,  // 繁中服进入中坚寻访的日期（同上）
    };
  }
  console.log(
    `· 干员 ${Object.keys(operators).length} 位（跳过无日期 ${skippedNoRarity}）`,
  );

  const opByName = new Map(Object.values(operators).map((o) => [o.name, o]));

  /** 供卡池解析使用：任意干员的星级 + 国服实装日（4★ 无日期，但本规则只关心 5★） */
  const opMeta = (name) => {
    const op = opByName.get(name);
    return {
      stars: rarityByName.get(name) ?? (op ? op.rarity : 0),
      scReleaseDate: op ? op.scReleaseDate : null,
    };
  };

  // 组装卡池 + 解析 UP 干员
  const { list, warnings } = buildBanners(pages, opMeta);

  const banners = {};
  let dropped = 0;
  const droppedNames = [];
  for (const b of list) {
    const upOperators = [];
    const dedup = new Set();
    for (const a of b.rawOps) {
      const rarity = rarityByName.get(a.name) ?? (a.col === 6 ? 6 : 5);
      if (rarity < 5) {
        dropped += 1;
        droppedNames.push(`${a.name}（${obtainByName.get(a.name) || '无记录'}）`);
        continue; // 4★ 不纳入范围
      }
      const known = opByName.get(a.name);
      if (!known) warnings.push(`卡池 ${b.id} 出现未知干员: ${a.name}`);
      const key = `${a.name}|${isShopArg(a.args)}`;
      if (dedup.has(key)) continue;
      dedup.add(key);
      upOperators.push({
        name: a.name,
        rarity,
        isLimited: known ? known.isLimited : Boolean(a.args.limited),
        isShop: isShopArg(a.args),
      });
    }
    // 确保 6★ 在前、5★ 在后，便于展示
    upOperators.sort((x, y) => (y.rarity - x.rarity) || Number(x.isShop) - Number(y.isShop));
    banners[b.id] = {
      name: b.name,
      scName: b.name,       // 国服中文名（与 name 相同，保留一列便于跨服对齐）
      enName: null,         // 国际服英文名，第二遍回填
      type: b.type,
      startDate: b.startDate,
      endDate: b.endDate,
      upOperators,
    };
  }
  console.log(`· 卡池 ${Object.keys(banners).length} 个（剔除 4★ 记录 ${dropped} 条）`);
  if (droppedNames.length) {
    console.log(`  被剔除的 4★（含 obtainMethod，用于核对筛选口径）: `
      + droppedNames.slice(0, 30).join('、'));
  }

  /* ---- 卡池的英文名（enName）----
     `banners_en.json` 是国际服脚本的地盘，本脚本**只读**。按干员集合把同一批池子对起来
     （只有限定 / 单六 / 双五三类有英文名，见 lib/banner-names.mjs）。
     ⚠️ 必须**按开始日升序**逐个查（banners 就是按 list 的顺序插入的）—— 复刻池与首跑池
        干员集合相同，靠「第 N 次出现」配对；`ownCounts` 用来处理国服特有的「返场」池。
     ⚠️ 国际服比国服慢，最新的几个池子对不上属正常 —— 不计入 warnings，只报个数。
     ⚠️ CI 里国际服那步在国服之后，所以这里读到的是**上一轮**的 banners_en.json；
        名字极少变，滞后一轮无影响，而且下一轮就自动补上。 */
  let enNameHits = 0;
  const enNameMiss = [];
  const prevEnBanners = await readPrev('banners_en.json');
  if (prevEnBanners) {
    const matchEnName = createNameMatcher(buildNameIndex(prevEnBanners), {
      overflow: false,
      ownCounts: countNameGroups(banners),
    });
    for (const [id, b] of Object.entries(banners)) {
      if (!nameGroupOf(b.type)) continue;
      const hit = matchEnName(b);
      if (hit) {
        /* 优先取对方明确给出的英文名；旧版 banners_en.json 还没这个字段，
           那时它的 `name` 就是英文名，所以退一步用它（过渡期用得上）。 */
        b.enName = hit.enName || hit.name || null;
        enNameHits += 1;
      } else {
        enNameMiss.push(`${id} ${b.name}（${b.startDate}）`);
      }
    }
  }
  const enNameTotal = Object.values(banners).filter((b) => b.enName).length;
  console.log(`· 卡池英文名：${enNameTotal} 个有 enName / ${enNameMiss.length} 个限定·单六·双五池暂时对不上国际服`
    + `${prevEnBanners ? '' : '（banners_en.json 不存在，全部留空）'}`);

  /* ---- 卡池所属活动：`actType` / `actName`（+ 单六寻访的 `canRerun` / `rerunKind`）----
     ⚠️ **只在带 `--with-activities`（CI 里只有周五那次带，见 update-data.yml）时真去抓**：
        活动类型变化很慢，没必要每次跑都花那 ~7 次请求。
     ⚠️ **不抓的那几次必须从旧文件回填** —— 否则重写 banners_sc.json 会把上次抓到的字段抹掉。
     ⚠️ `canRerun` / `rerunKind` **只给 `single`**（常驻轮换池谈「会不会复刻」没意义）；
        `actType` / `actName` 所有卡池都写（反正是白拿的）。 */
  const withActivities = process.argv.includes('--with-activities')
    || process.env.WITH_ACTIVITIES === '1';
  const bannerFileName = `banners_${DEFAULT_SERVER}.json`;
  const bannerTotal = Object.keys(banners).length;
  const singleTotal = Object.values(banners).filter((b) => b.type === 'single').length;
  if (withActivities) {
    const { map, pageCount, parsed } = await fetchActivityMap();
    let hit = 0;
    const miss = [];
    for (const [id, b] of Object.entries(banners)) {
      /* 「返场」池**活动页不会列**（它只是首发活动期内的二次开放）→ 去掉后缀再查一次，
         否则它的 actType 会是 null、canRerun 被误判成 false。
         （实测「不羁逆流 返场」之后**确实**又复刻了一次 → 该 true。） */
      const found = map[normName(b.name)]
        || (/返场/.test(b.name) ? map[normName(b.name.replace(/返场/g, ''))] : null)
        || null;
      b.actType = found ? found.actType : null;
      b.actName = found ? found.actName : null;
      if (b.type === 'single') {
        /* 口径：**只有支线故事的单六寻访会复刻，且只复刻一次**（实测非支线的 0 反例）。
           ⚠️ 用户 2026-10-05 定：**`canRerun` 只对「首发」池为 true** ——
              「复刻」池与「返场」池都算**已经再上架过一次**，不再有下一次。
           两个已知反例写死在 CAN_RERUN_EXCEPTIONS 里。 */
        const kind = /返场/.test(b.name) ? '返场' : (/复刻/.test(b.name) ? '复刻' : '首发');
        b.rerunKind = kind;
        b.canRerun = Boolean(found) && found.actType === '支线故事'
          && kind === '首发' && !CAN_RERUN_EXCEPTIONS.has(b.name);
      }
      if (found) hit += 1; else miss.push(`${id} ${b.name}`);
    }
    const canRerunCount = Object.values(banners).filter((b) => b.canRerun).length;
    console.log(`· 卡池所属活动：活动页 ${pageCount} 个（解析出 ${parsed} 个）→ 关联上 ${hit}/${bannerTotal} 个卡池`
      + `；单六寻访 ${singleTotal} 个中 canRerun=true 的 ${canRerunCount} 个`);
    if (miss.length) {
      console.log(`  ${miss.length} 个对不上（actType 留 null，多为 2019~2020 早期池，其活动页还没写 限时寻访）：`
        + `${miss.slice(0, 6).map((x) => x.split(' ')[1]).join('、')}${miss.length > 6 ? ' 等' : ''}`);
    }
  } else {
    const prev = (await readPrev(bannerFileName)) || {};
    let kept = 0;
    let fresh = 0;
    for (const [id, b] of Object.entries(banners)) {
      const old = prev[id];
      b.actType = old?.actType ?? null;
      b.actName = old?.actName ?? null;
      if (b.type === 'single') {
        /* ⚠️ 赋值顺序必须与上面「抓取」那段**完全一致**（rerunKind 在前）：
           否则 JSON 的键序不同 → 字符串比对不相等 → 每次跑都误判成「有变化」而写盘。 */
        b.rerunKind = old?.rerunKind ?? null;
        b.canRerun = old?.canRerun ?? false;
      }
      if (old && 'actType' in old) kept += 1; else fresh += 1;
    }
    console.log(`· 卡池所属活动：本次不抓（非周五、也没带 --with-activities）→ 从上次快照回填 ${kept} 个`
      + `${fresh ? `；${fresh} 个新池暂缺 actType（下周五补上）` : ''}`);
  }

  // 校验
  const dates = Object.values(banners).map((b) => b.startDate).sort();
  const bannerCount = Object.keys(banners).length;
  const meta = {
    generatedAt: todayBeijing(),
    /* 另外两个服务器的「数据更新日」由各自的脚本维护，这里原样沿用：
       enGeneratedAt 由 fetch-data-en.mjs 在**它自己的产出有变化**时更新；
       tcGeneratedAt 由 fetch-data-tc.mjs 填成 banners_tc.json 的修改日。 */
    enGeneratedAt: prevMeta.enGeneratedAt ?? null,
    tcGeneratedAt: prevMeta.tcGeneratedAt ?? null,
    defaultServer: DEFAULT_SERVER,
    /* 服务器列表：前端据此渲染「服务器」下拉框（只列 available 的项）。
       卡池规模按服务器统计；干员表各服共用一份 operators.json，靠 *ReleaseDate 区分。 */
    /* 默认服务器的数字由本脚本算；其余服务器（国际服 / 繁中服）的
       available / bannerCount / 日期区间由各自的脚本负责
       （见 fetch-data-en.mjs / fetch-data-tc.mjs），
       这里原样沿用旧文件，免得把别的服务器的状态覆盖掉。 */
    servers: SERVERS.map((s) => {
      if (s.id === DEFAULT_SERVER) {
        return {
          id: s.id,
          label: s.label,
          available: true,
          bannerCount,
          earliestBanner: dates[0] || null,
          latestBanner: dates[dates.length - 1] || null,
        };
      }
      const prev = (prevMeta.servers || []).find((x) => x.id === s.id);
      return prev
        ? { ...prev, label: s.label }
        : { id: s.id, label: s.label, available: s.available, bannerCount: 0, earliestBanner: null, latestBanner: null };
    }),
    source: 'https://prts.wiki',
    /* ⚠️ 国服自己的 4 个来源页 + **沿用旧文件里别人追加的**（国际服写 arknights.wiki.gg、
       繁中服写金山文档）。写成并集、别写死 —— 否则每跑一次国服脚本就会把
       另两个脚本追加的来源项抹掉，它们再跑又加回来，来回都是“有变化”，
       在 CI 里就是一堆空提交。 */
    sourcePages: [
      ...CN_SOURCE_PAGES,
      /* ⚠️ 只沿用**别人追加的**来源页（国际服 / 繁中服），并且要把**已停用的国服页**滤掉 ——
         否则「卡池一览/常驻中坚寻访&中坚甄选」会一直残留在旧 metadata 里
         （它已不在 CN_SOURCE_PAGES 里，但因为不属于 CN_SOURCE_PAGES 就被当成「别人加的」留下了）。 */
      ...((prevMeta.sourcePages || []).filter((p) => !CN_SOURCE_PAGES.includes(p) && !RETIRED_SOURCE_PAGES.includes(p))),
    ],
    operatorCount: Object.keys(operators).length,
  };

  validate(operators, banners, meta);

  /* ---- 只在内容真的变了才写盘 ----
     为什么要这样：GitHub Actions 每周定时跑一次。若数据没更新却照样写文件，
     `generatedAt` 就会白跳一天，还会产生一堆「内容其实没变」的空提交 ——
     而站点把 `generatedAt` 当作**参考日期的初始值**，乱跳会直接影响统计口径。
     所以：内容一致 → 不写盘、沿用旧的 generatedAt → git 看不到改动 → 工作流不提交。 */
  await fs.mkdir(OUT_DIR, { recursive: true });

  const bannerFile = `banners_${DEFAULT_SERVER}.json`;
  const readOld = async (name) => {
    try { return await fs.readFile(path.join(OUT_DIR, name), 'utf8'); } catch { return null; }
  };
  const stab = (v) => JSON.stringify(v, null, 2) + '\n';
  /** 内容一致就不写；返回是否真的写了 */
  const put = async (name, text) => {
    if (await readOld(name) === text) return false;
    await fs.writeFile(path.join(OUT_DIR, name), text, 'utf8');
    return true;
  };

  const nextOps = stab(operators);
  const nextBanners = stab(banners);

  /* 元信息要**先剔掉三个「更新日」再比对** —— 否则只因为日期变了就永远“有变化”。
     （enGeneratedAt / tcGeneratedAt 由另外两个脚本维护，这里也要一起剔，
       不然每次跑都会把对方写的日期看成“变化”，凭空产生一次提交。） */
  const metaNoDate = metaStable(meta);
  const prevMetaRaw = await readOld('metadata.json');
  let prevGeneratedAt = null;
  let prevMetaNoDate = null;
  if (prevMetaRaw) {
    try {
      prevMetaNoDate = metaStable(JSON.parse(prevMetaRaw));
      prevGeneratedAt = JSON.parse(prevMetaRaw).generatedAt || null;
    } catch { prevMetaNoDate = null; } // 旧文件坏了就当成“有变化”
  }

  const dataChanged = prevMetaRaw === null
    || (await readOld('operators.json')) !== nextOps
    || (await readOld(bannerFile)) !== nextBanners
    || stab(metaNoDate) !== (prevMetaNoDate === null ? null : stab(prevMetaNoDate));

  /* 没变化 → 沿用旧的快照日；有变化 → 今天 */
  const generatedAt = dataChanged ? todayBeijing() : (prevGeneratedAt || todayBeijing());
  /* 展开时 generatedAt 已在 meta 里，覆盖它不会改变 key 的顺序（否则又会“看起来变了”）；
     再过一遍 orderMeta 统一键序，避免与另外两个脚本写出的键序不同而互相看成“改过了”。 */
  const finalMeta = orderMeta({ ...meta, generatedAt });

  const wrote = [
    (await put('operators.json', nextOps)) && 'operators.json',
    (await put(bannerFile, nextBanners)) && bannerFile,
    (await put('metadata.json', stab(finalMeta))) && 'metadata.json',
  ].filter(Boolean);

  if (warnings.length) {
    console.warn(`\n⚠ 共 ${warnings.length} 条警告：`);
    for (const w of warnings.slice(0, 40)) console.warn('  - ' + w);
    if (warnings.length > 40) console.warn(`  ... 其余 ${warnings.length - 40} 条已省略`);
  }

  if (!wrote.length) {
    console.log('\n✓ 数据无变化（干员 / 卡池 / 元信息都与上次一致）');
    console.log(`  未写盘，generatedAt 保持 ${generatedAt}`);
    return;
  }
  console.log('\n✓ 数据生成完成');
  console.log(`  干员 ${meta.operatorCount} 位 / 卡池 ${bannerCount} 个`);
  console.log(`  卡池时间范围 ${dates[0] || '—'} ~ ${dates[dates.length - 1] || '—'}`);
  console.log(`  本次实际写入：${wrote.join('、')}`);
  console.log(`  generatedAt ${generatedAt}${dataChanged ? '' : '（沿用）'}`);
  console.log(`  输出目录 ${path.relative(ROOT, OUT_DIR)}`);
}

function validate(operators, banners, meta) {
  const problems = [];
  const sc = meta.servers.find((s) => s.id === meta.defaultServer) || {};
  if (meta.operatorCount < 50) problems.push(`干员数量异常偏少: ${meta.operatorCount}`);
  if ((sc.bannerCount || 0) < 50) problems.push(`卡池数量异常偏少: ${sc.bannerCount}`);
  for (const [id, b] of Object.entries(banners)) {
    for (const f of ['name', 'scName', 'type', 'startDate', 'endDate']) {
      if (!b[f]) problems.push(`卡池 ${id} 缺少字段 ${f}`);
    }
    /* enName 可以为 null（带序号的池子三服同名、国际服还没出的池子也还没英文名），
       但这个字段本身必须存在，否则站点侧没法区分「没有英文名」和「忘了写」。 */
    if (!('enName' in b)) problems.push(`卡池 ${id} 缺少字段 enName`);
    if (b.name !== b.scName) problems.push(`卡池 ${id} 的 name 与 scName 不一致: ${b.name} / ${b.scName}`);
    if (!Array.isArray(b.upOperators) || b.upOperators.length === 0) {
      problems.push(`卡池 ${id} 没有 UP 干员`);
    }
    for (const op of b.upOperators) {
      for (const f of ['name', 'rarity', 'isLimited', 'isShop']) {
        if (op[f] === undefined) problems.push(`卡池 ${id} 的 UP 干员缺少字段 ${f}`);
      }
    }
  }
  for (const [cid, op] of Object.entries(operators)) {
    for (const f of ['name', 'charId', 'rarity', 'scReleaseDate', 'enReleaseDate', 'tcReleaseDate', 'obtainMethod', 'isLimited']) {
      if (op[f] === undefined) problems.push(`干员 ${cid} 缺少字段 ${f}`);
    }
    if (!op.scReleaseDate) problems.push(`干员 ${cid} 缺少国服实装日`);
    if (![5, 6].includes(op.rarity)) problems.push(`干员 ${cid} 星级异常: ${op.rarity}`);
  }
  if (problems.length) {
    console.error('\n✗ 数据校验未通过：');
    for (const p of problems.slice(0, 30)) console.error('  - ' + p);
    throw new Error(`数据校验失败，共 ${problems.length} 个问题`);
  }
  console.log('· 数据校验通过');
}

main().catch((e) => {
  console.error('\n✗ 构建失败: ' + e.message);
  process.exit(1);
});
