#!/usr/bin/env node
/**
 * fetch-data-en.mjs
 * 从 **wiki.gg**（arknights.wiki.gg）抓取**国际服（Global / NA）**的寻访数据，
 * 产出 `data/banners_en.json`，并把国际服相关的字段写回 `data/operators.json` 与 `data/metadata.json`。
 *
 * 数据来源：
 *   1. **Cargo `Banners` 表**（2026-11-10 起为主路径，`action=cargoquery`，一次查询拿全部）：
 *      那 7 个 `Headhunting/Banners/<年份>` 页里的每个 `{{Banners cell}}` 都会执行模板内部的
 *      `{{#cargo_store: _table=Banners …}}` —— **这张表就是页面的投影**，页面一保存就写表，
 *      **没有延迟**（实测逐页行数与模板调用数完全一致 48/48、78/78、76/76、66/66；
 *      切换前后产出**逐字节相同**）。
 *      ⚠️ 兜底：Cargo 请求失败 / 返回 0 行时自动回退到「抓页面 + 解析模板」；
 *         也可以 `--templates` 强制走它（两条路径对撞用）。
 *   2. 读哪些字段（括号里是旧模板参数，兜底路径仍按那套解析）：
 *        bannerType  卡池类型，见下方 TYPE_MAP
 *        no          序号（常驻 / 中坚 / 联合行动 / 定向甄选 / 前路回响 用）
 *        name        卡池英文名（限定 / 单六 / 双五 用）
 *        startTimeCN / endTimeCN            国服时间（不用）
 *        startTimeGlobal / endTimeGlobal    国际服时间   ← **优先认这两个**
 *        startTime / endTime                常驻标准寻访 / 常驻中坚寻访 / 中坚甄选 的国际服时间
 *                                           （这三类国际服的池子与国服不同，页面里只列国际服的，
 *                                             所以落在这一对字段上；两种字段并存，取任一非空）
 *        operators   干员英文名，逗号分隔（模板里 `operators` + `operators1` + `operators2`
 *                    用 `{{#lstsep:…}}` 合并后存的，所以甄选类池子的两段也在里面）
 *        store       与 operators 一一对应的 0/1，1 = 可商店兑换
 *        limited     与 operators 一一对应的 0/1/2（只有限定寻访有）：
 *                      0 = 普通 UP 干员   1 = 本期限定干员   2 = **5 倍权值**的往期限定干员
 *                    ⚠️ 值为 2 的那些**不算 UP**（用户口径）：它们只是复刻规则里
 *                       5 倍权重的往期限定，wiki.gg 却把它们和真正的 UP 并排写在
 *                       `operators` 里。**必须剔掉** —— 否则限定寻访会多出 2~3 个
 *                       六星，站点侧（限定干员一律排除）和「双五/单六」的集合反查都会错。
 *   3. charId 映射：`Operators ⋈ OperatorFiles` **一次查齐**（英文名 + 星级 + F.id），
 *      卡池数据里只有英文名，而站点一律用中文名索引，所以这个映射是关键。
 *      （此前是「Operators 清单 + 分批抓干员页 wikitext」，仅映射就要 ~9 次请求，已合并。）
 *   4. 卡池名：限定寻访 / 单六寻访 / 双五寻访的 `|name` 是**英文名**，
 *      写成 `enName`；`scName` 用**国服中文名**（按干员集合反查 banners_sc.json，
 *      见 lib/banner-names.mjs）。带序号的池子（常驻 / 中坚 / 联合行动…）三服同名，
 *      `enName` 为 null。ID 里的名称段仍是**英文名首字母**，不随改名变动（ID 要保持稳定）。
 *      ⚠️ 2026-10-12 起卡池**不再写 `name`**（与 `scName` 重复，已删）；
 *         干员的 `enName` 也**不再由本脚本写**（改由 `fetch-data.mjs` 从官方解包 en 表取，
 *         实测与这里原来的 wiki.gg 页面名 222/222 逐字符相同）。
 *         `upOperators` 项同理：`name` → `scCharName` + `charId`。
 *   5. `enReleaseDate`（国际服上线日）：来自 wiki.gg 的 cargoquery，join
 *      `Operators` / `OperatorFiles` / `EventServerDetails` 三表，取该干员登场事件在
 *      global 服的 startTime（同一干员可能命中多个事件，取最早）。取不到的
 *      （少数没挂 event 的干员）退化为「首次出现在国际服卡池」的日期。
 *      ⚠️ **开服干员（`scReleaseDate` ≤ 2019-04-30，共 35 位）锚定为开服日 2020-01-16**
 *      —— 这批人的「首次出现」是开服后的普通轮换，而 wiki 那张事件表也曾整批滞后（见常量注释）。
 *
 * 用法：
 *   node scripts/fetch-data-en.mjs            # 抓取并写盘（内容没变则不写）
 *   node scripts/fetch-data-en.mjs --dry      # 只抓取与统计，不写盘
 *   node scripts/fetch-data-en.mjs --templates  # 强制走旧的「页面模板解析」路径（应急 / 对撞）
 *
 * ⚠️ 国际服比国服更新慢，所以不会出现「国际服有、国服没有」的干员。
 *    遇到对不上的干员（多半是 4★）会被剔掉并计入警告。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { orderMeta } from './lib/meta.mjs';
import { buildNameIndex, createNameMatcher, nameGroupOf } from './lib/banner-names.mjs';
import { resortSeriesBanners, sortUpOperators } from './lib/banner-ops.mjs';
import { makeMidBatchResolver, dryRun } from './lib/mid-batches.mjs';
import { wikiApi, fetchWikiOperatorMap } from './lib/wiki-gg.mjs';
import './lib/http.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'data');

/* ⚠️ wiki.gg 的 API 入口 / 请求头 / 重试封装已抽到 `lib/wiki-gg.mjs`
   （2026-10-12：`fetch-data.mjs` 也要用它给 enName / jpName 兜底） */

const SERVER = 'en';

/* ---- 开服锚定 ----
 * 国际服（Global，Yostar）**2020-01-16** 开服，开服干员集合与国服开服一致
 * （`scReleaseDate` 全部 = 2019-04-30，实测 35 位，一个不差）。
 * ⚠️ wiki.gg 的 `Opening Event` 在 global 侧有**多条**记录（2020-01-16 开服 / 01-22 / 02-05
 * 后续三段），脚本虽然取最早，但这批干员**实测曾被整批标成 2020-02-05**
 * ——那是开服后的普通轮换，不是实装日。**与繁中服是同一个坑**（见 fetch-data-tc.mjs 的
 * `TC_LAUNCH_DATE`，那边当时就锚定了，国际服漏了）。
 * → 开服干员的国际服实装日**锚定为开服日**，不依赖 wiki 那张事件表是否补全。 */
const EN_LAUNCH_DATE = '2020-01-16';
const CN_LAUNCH_DATE = '2019-04-30';
/* ⚠️ 只在**兜底路径**用（Cargo 失败 / `--templates`）—— 主路径读 Cargo `Banners` 表，
   见下面 `fetchBannersFromCargo()` 的文件头说明。 */
const YEAR_PAGES = ['2020', '2021', '2022', '2023', '2024', '2025', '2026'];

/** wiki.gg 的 type → 本站的 type。未列出的（联动等）一律忽略。 */
const TYPE_MAP = {
  standard: 'double',
  kernel: 'classic',
  'kernel locating': 'clafes',
  jo: 'joint',
  orient: 'stdfes',
  tftw: 'mainfes',
  celebration: 'limcel',
  festival: 'limspr',
  carnival: 'limsum',
  special: 'single',
  rerun: 'single',
  /* 限定寻访的**复刻**池：wiki.gg 单独标成 limited rerun，
     但国服是把它算进限定寻访的（例如「地生五金 复刻」= limspr）。
     这里用「干员集合与国服某池完全一致」反查它属于哪一种限定寻访。 */
  'limited rerun': 'LIM_FROM_CN',
};
/** 明确要忽略的 type（联动 / 跨年欢庆 —— 国服数据同样不收） */
const SKIP_TYPES = ['linkup', 'kernel linkup', 'crossover', 'crossover rerun'];

const SEQ_TYPES = ['joint', 'stdfes', 'mainfes'];
const pad4 = (n) => String(n).padStart(4, '0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 北京时间下的今天 YYYY-MM-DD */
function todayBeijing() {
  const t = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return t.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- 网络

/* 发请求的 `api()` 已抽到 `lib/wiki-gg.mjs` 的 `wikiApi()`（本脚本与 fetch-data.mjs 共用）。
   调用处仍写作 `wikiApi({...})`，行为与原来的 `api()` 完全一致。 */

// ---------------------------------------------------------------- 工具

function toDate(raw) {
  const m = /(\d{4})[/-](\d{1,2})[/-](\d{1,2})/.exec(String(raw || ''));
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

/** 英文卡池名 → ID 名称段：各单词首字母小写拼接 */
function initialsOf(name) {
  return String(name || '')
    .replace(/[^A-Za-z0-9 ]+/g, ' ')      // 去掉标点（撇号、逗号、连字符…）
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toLowerCase())
    .join('');
}

/** 一个 `{{Banners cell}}` → 参数对象 */
function parseCell(body) {
  const out = {};
  let key = null;
  for (const line of body.split('\n')) {
    const m = /^\s*\|\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) {
      key = m[1].toLowerCase();
      out[key] = m[2].trim();
    } else if (key && line.trim() && !/^\s*[|}]/.test(line)) {
      out[key] += '\n' + line.trim();
    }
  }
  return out;
}

const stripComments = (text) => String(text).replace(/<!--[\s\S]*?-->/g, '');

/**
 * `{{Banners cell}}` 模板的开头。
 * ⚠️ **wiki 上两种写法都有**：`{{Banners cell`（空格）与 `{{Banners_cell`（下划线）。
 * 2026-10-01 踩过：原来只按空格切，结果 2024 页里唯一那条下划线写法的
 * 「烁尘烟中」（From Gleams and Smoke I Emerge）**整条被静默丢掉** ——
 * 少一个卡池，而且没有任何报错，害得我一度以为上游缺数据。
 * 所以分隔符用 `[\s_]*`（空格 / 下划线 / 直接连写都认），另加下面那个兜底检查。
 */
const CELL_OPEN = /\{\{\s*Banners[\s_]*cell/i;

/** 页面 wikitext → 所有 cell 的参数对象 */
function parseCells(text) {
  return stripComments(text)
    .split(CELL_OPEN)
    .slice(1)
    .map((chunk) => chunk.split('}}')[0])
    .filter((body) => body.includes('|'))
    .map(parseCell);
}

/**
 * ⚠️ 兜底：页面里每一个 `{{Banners…` 开头都该被 `CELL_OPEN` 吃掉，否则**整条卡池会被静默丢掉**。
 * 这里报出所有「既不是我们认得的 cell、也不是表格头尾模板」的写法 ——
 * 将来 wiki 再换写法（如 `{{Banners row`）就能立刻发现，不用靠肉眼比对卡池数。
 */
function unmatchedBannerTemplates(text) {
  const clean = stripComments(text);
  const out = new Set();
  for (const m of clean.matchAll(/\{\{\s*Banners[^}|]{0,24}/gi)) {
    const snippet = m[0];
    if (CELL_OPEN.test(snippet)) continue;                              // 认得的 cell
    if (/^\{\{\s*Banners[\s_]*(head|end)\b/i.test(snippet)) continue;   // {{Banners head}} / {{Banners end}}：表格头尾，正常
    out.add(snippet.trim());
  }
  return [...out];
}

const splitNames = (s) =>
  String(s || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * 名字归一化 —— 卡池模板里的写法与干员页标题**未必逐字相同**：
 *   卡池里写 `Mlynar`，干员页标题是 `Młynar`（带 ł）；
 *   还有 `Ch'en`（撇号）、`Wiś'adel`（ś）之类。
 * 所以两边都用这个函数做键，只保留「字母数字」，并抹平变音符号。
 */
function normKey(str) {
  return String(str || '')
    .replace(/[łŁ]/g, 'l')
    .replace(/[øØ]/g, 'o')
    .replace(/[đĐðÐ]/g, 'd')
    .replace(/[æÆ]/g, 'ae')
    .replace(/[œŒ]/g, 'oe')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// ---------------------------------------------------------------- 干员映射

/* `fetchOperatorMap()` 已抽到 `lib/wiki-gg.mjs` 的 `fetchWikiOperatorMap()`
   （同一个 cargoquery：Operators ⋈ OperatorFiles → charId / 页名(英文名) / 星级）。 */

// ---------------------------------------------------------------- 卡池

/** 抓各年份的卡池页 */
async function fetchBannerPages() {
  console.log('· 抓取卡池页（Headhunting/Banners/<年份>）...');
  const pages = {};
  for (const y of YEAR_PAGES) {
    const json = await wikiApi({ action: 'parse', page: `Headhunting/Banners/${y}`, prop: 'wikitext' });
    const text = json.parse?.wikitext || '';
    if (text) pages[y] = text;
    console.log(`  ${y}: ${text.length} 字符`);
  }
  return pages;
}

/* ---------------- 卡池来源：Cargo `Banners` 表（2026-11-10 起为主，模板降为兜底） ----------------
 * 为什么换：原来要抓 7 个年度页、正则切 `{{Banners cell}}`，还得分空格 / 下划线两种写法
 * （认错一个就**静默漏整条池**）。而那 7 个页里的每一个 cell 都会执行
 * `Template:Banners cell` 内部的 `{{#cargo_store: _table=Banners …}}` ——
 * 也就是说**这张 Cargo 表就是那几个页面的投影**，页面一保存就写表，不存在延迟。
 *
 * 2026-11-10 实测：逐页行数与模板调用数完全一致（2020 48/48、2024 78/78、2025 76/76、2026 66/66）；
 * 与 `banners_en.json` 现有 320 期按「开池日 + 结束日」对撞 **320/320 全中、日期一字不差**。
 *
 * 收益：① 一次查询替掉 7 个页面抓取；② 不怕模板写法变体（store 在模板内部执行）；
 *      ③ 顺带拿到 `startTimeCN` / `startTimeTW`（本脚本暂不用，留给跨服校验）。
 * 剩下的唯一风险是「模板参数改名导致某个 store 字段变空」—— 盯字段填充率即可
 * （2026-11-10：operators 422/425、bannerType 424/425、国际服时间 411/425）。
 */

/** Cargo 行 → 与 `parseCells()` 同形状的 cell（主循环只认这几个键） */
function cargoRowToCell(c) {
  return {
    type: c.bannerType,
    name: c.name,
    no: c.no,
    /* ⚠️ 与旧逻辑 `cell.globalstart || cell.start` 完全同序：global 优先。
       两种字段并存是 wiki 的录入习惯（2026-11-10 统计 startTime 244 行 / startTimeGlobal 167 行），
       所以不能只认其中一个。 */
    globalstart: c.startTimeGlobal || c.startTime,
    globalend: c.endTimeGlobal || c.endTime,
    /* 模板里是 `{{#lstsep:{{{operators}}},{{{operators1}}},{{{operators2}}}|,|,}}` 合并后存的，
       所以这一段已经包含联合行动等池子的第二、三段干员，无需再分开收。 */
    operators: c.operators,
    store: c.store,
    limited: c.limited,
  };
}

/** 直接读 Cargo 表，按 `_pageName` 分组返回（形状与 `cellsFromTemplates()` 一致） */
async function fetchBannersFromCargo() {
  console.log('· 抓取卡池表（Cargo: Banners）...');
  const groups = {};
  let total = 0;
  for (let offset = 0; ; offset += 500) {
    const json = await wikiApi({
      action: 'cargoquery',
      tables: 'Banners',
      fields: 'name,no,bannerType,operators,store,limited,'
        + 'startTime,endTime,startTimeGlobal,endTimeGlobal,_pageName',
      limit: 500,
      offset,
    });
    const rows = json.cargoquery || [];
    for (const r of rows) {
      const src = r.title._pageName || 'Banners';
      (groups[src] ||= []).push(cargoRowToCell(r.title));
      total += 1;
    }
    if (rows.length < 500) break;
    if (offset > 5000) break; /* 安全阀 */
  }
  console.log(`  → ${total} 行（${Object.keys(groups).length} 个来源页）`);
  return groups;
}

/** 旧路径：抓年度页 + 正则切 `{{Banners cell}}`（只在 Cargo 失败时兜底，或 `--templates` 强制用） */
async function cellsFromTemplates(warnings) {
  const pages = await fetchBannerPages();
  const groups = {};
  for (const [year, text] of Object.entries(pages)) {
    /* 有没被识别出来的 {{Banners…}} 写法就直接报出来（漏一条就是漏一个卡池） */
    const unmatched = unmatchedBannerTemplates(text);
    if (unmatched.length) {
      warnings.push(`[${year}] 有 ${unmatched.length} 个 {{Banners…}} 模板没被识别（wiki 换写法了？）：`
        + unmatched.slice(0, 4).join(' / '));
    }
    groups[year] = parseCells(text);
  }
  return groups;
}

/** 取卡池行：Cargo 为主，模板兜底 */
async function loadBannerCells(warnings) {
  if (process.argv.includes('--templates')) {
    console.log('· 已指定 --templates：走旧的页面模板解析');
    return cellsFromTemplates(warnings);
  }
  try {
    const groups = await fetchBannersFromCargo();
    if (!Object.keys(groups).length) throw new Error('Cargo 返回 0 行');
    return groups;
  } catch (e) {
    warnings.push(`Cargo 取卡池失败（${e.message}），回退到页面模板解析`);
    return cellsFromTemplates(warnings);
  }
}

// ---------------------------------------------------------------- 国际服上线日期

/**
 * 国际服（global）上线日期：来自 wiki.gg 的 cargoquery，join
 * `Operators` / `OperatorFiles` / `EventServerDetails` 三表，
 * 取该干员**登场事件**在 global 服的 startTime。
 *
 * ⚠️ `Operators.event` 是多值字段，一个干员会关联多个 event（首登 + 复刻 / 剧情），
 *    所以同一 charId 会命中多条 startTime —— 取**最早**那条当上线日。
 * 服务端过滤：只查 5★/6★（wiki.gg 的 rarity 就是星级本身），并排除 eventObtain 非空的
 * 「活动赠送」干员（2026-10-03 实测：这 64 个干员国服 obtainMethod 均为「活动获取」类，
 * 进不了 operators.json，enReleaseDate 本来就不会被计算，过滤对输出零影响）。
 * 取不到的（少数没挂 event 的干员）由调用方退化到「首次出现在国际服卡池」的日期。
 */
async function fetchEnReleaseDates() {
  console.log('· 抓取 wiki.gg 国际服上线日期（登场事件 startTime）...');
  const map = {}; // charId → 最早 startTime (YYYY-MM-DD)
  for (let offset = 0; offset < 2000; offset += 500) {
    const json = await wikiApi({
      action: 'cargoquery',
      tables: 'Operators=O,OperatorFiles=F,EventServerDetails=S',
      fields: 'S.startTime=start,F.id=charId,O.name=name', // name 代码没用到，便于人工核对
      join_on: 'O.event=S.event,F.name=O.name',
      where: "F.id IS NOT NULL AND S.startTime IS NOT NULL AND S.server LIKE 'global' "
        + "AND O.rarity IN (5,6) AND (O.eventObtain IS NULL OR O.eventObtain = '')",
      limit: 500,
      offset,
    });
    const rows = json.cargoquery || [];
    if (!rows.length) break;
    for (const r of rows) {
      const cid = r.title.charId;
      const d = toDate(r.title.start);
      if (!cid || !d) continue;
      if (!map[cid] || d < map[cid]) map[cid] = d;
    }
    if (rows.length < 500) break;
  }
  console.log(`  → ${Object.keys(map).length} 个干员有国际服上线日`);
  return map;
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const dry = process.argv.includes('--dry');

  // —— 读国服数据（干员表 + 卡池表），用来对齐 charId / 中文名 / 抵店 / 双五判定
  const cnOperators = JSON.parse(await fs.readFile(path.join(OUT_DIR, 'operators.json'), 'utf8'));
  const cnBanners = JSON.parse(await fs.readFile(path.join(OUT_DIR, 'banners_sc.json'), 'utf8'));
  const cnByName = new Map(Object.values(cnOperators).map((o) => [o.scName, o]));
  /** charId → 国服卡池 */
  const cnByCharId = cnOperators;

  /** 国服卡池的「干员集合」→ 卡池，用于把国际服的同名池子对回国服（借它的 isShop） */
  const setKeyOf = (charIds) => [...new Set(charIds)].sort().join('|');
  const cnByOpSet = new Map();
  for (const [id, b] of Object.entries(cnBanners)) {
    const ids = b.upOperators.map((o) => cnByName.get(o.scCharName)?.charId).filter(Boolean);
    if (ids.length === b.upOperators.length) cnByOpSet.set(setKeyOf(ids), { id, ...b });
  }
  /** 国服「双五寻访」的干员集合 → 国际服的同一批池子靠它认出来 */
  const cnFiveSets = new Map();
  const cnFiveNames = [];
  for (const [id, b] of Object.entries(cnBanners)) {
    if (b.type !== 'five') continue;
    const ids = b.upOperators.map((o) => cnByName.get(o.scCharName)?.charId).filter(Boolean);
    if (ids.length) {
      cnFiveSets.set(setKeyOf(ids), id);
      cnFiveNames.push(`${id} ${b.scName}`);
    }
  }
  console.log(`· 国服数据：干员 ${Object.keys(cnOperators).length} / 卡池 ${Object.keys(cnBanners).length}`);
  console.log(`  国服「双五寻访」共 ${cnFiveSets.size} 个：${cnFiveNames.join('、')}`);

  const byCharId = await fetchWikiOperatorMap();
  /** 英文名 → charId（本体行 —— charId 在 operators.json 里 —— 优先占位，变体行只补空位） */
  const byEnName = new Map();
  for (const [charId, v] of byCharId) {
    if (cnOperators[charId]) byEnName.set(normKey(v.enName), charId);
  }
  for (const [charId, v] of byCharId) {
    const key = normKey(v.enName);
    if (!byEnName.has(key)) byEnName.set(key, charId);
  }

  /* ⚠️ `warnings` 要在取卡池之前建好：Cargo 失败回退模板时，兜底日志要写进同一个数组 */
  const warnings = [];
  const bannerCells = await loadBannerCells(warnings);
  const enReleaseDates = await fetchEnReleaseDates();

  const skippedTypes = new Map();
  const banners = [];
  let dropped4 = 0;
  let dropped5x = 0;
  /** 没有国际服日期的行（多为 `Banners/Upcoming` 的预告池） */
  const skippedNoDate = [];

  /* `bannerCells` 是按来源页分组的数据（Cargo 的 `_pageName` / 兜底的年份）。
     日志里的 `[year]` 只取最后一段（`Headhunting/Banners/2020` → `2020`），与改动前一致。 */
  for (const [page, cellList] of Object.entries(bannerCells)) {
    const year = String(page).split('/').pop();
    for (const cell of cellList) {
      const rawType = String(cell.type || '').trim().toLowerCase();
      if (!rawType) continue;
      if (SKIP_TYPES.includes(rawType)) {
        skippedTypes.set(rawType, (skippedTypes.get(rawType) || 0) + 1);
        continue;
      }
      const type = TYPE_MAP[rawType];
      if (!type) {
        skippedTypes.set(rawType, (skippedTypes.get(rawType) || 0) + 1);
        continue;
      }
      /* 国际服日期：优先 globalstart/globalend，没有就用 start/end
         （常驻标准寻访 / 常驻中坚寻访 / 中坚甄选 这三类在 wiki.gg 上只列国际服，
           所以直接用 start/end） */
      const startDate = toDate(cell.globalstart || cell.start);
      const endDate = toDate(cell.globalend || cell.end);
      if (!startDate) {
        /* 主要是 `Headhunting/Banners/Upcoming` 里的预告池（wiki 上还没排期）。
           Cargo 会把这张页也一起给出来，逐条 warning 会刷屏 → 收进数组末尾汇总一行。 */
        skippedNoDate.push(`${rawType}${cell.name ? ' ' + cell.name : ''}`);
        continue;
      }

      // —— 干员列表（英文名）
      /* `store` / `limited` 都只跟 `|operators` 一一对应（operators1 / operators2 没有），
         所以先把三段拍平成同一个数组、把标志跟着名字一起带上。 */
      const entries = [];
      const collect = (namesRaw, storeRaw, limitedRaw) => {
        const names = splitNames(namesRaw);
        const stores = splitNames(storeRaw);
        const limited = splitNames(limitedRaw);
        names.forEach((en, i) => entries.push({
          en,
          isShop: stores[i] === '1',
          limited: limited[i] ?? '0',
        }));
      };
      collect(cell.operators, cell.store, cell.limited);
      collect(cell.operators1, '', '');
      collect(cell.operators2, '', '');

      /* ⚠️ 剔掉 `limited = 2` 的干员：那是「5 倍权值」的往期限定，
         只是复刻规则里的权重提升，**不算 UP**（用户口径）。详见文件头。 */
      const kept = entries.filter((e) => e.limited !== '2');
      dropped5x += entries.length - kept.length;

      const enNames = kept.map((e) => e.en);
      if (!enNames.length) {
        warnings.push(`[${year}] 没有干员，跳过: type=${rawType} ${startDate}`);
        continue;
      }

      const upOperators = [];
      const seen = new Set();
      const charIds = [];
      kept.forEach(({ en, isShop }) => {
        const charId = byEnName.get(normKey(en));
        const info = charId ? byCharId.get(charId) : null;
        const cn = charId ? cnByCharId[charId] : null;
        const rarity = info?.rarity ?? cn?.rarity ?? null;
        /* 先按星级筛：4★ 一律剔掉（本站只收 5★/6★），不算异常 */
        if (rarity !== null && rarity < 5) { dropped4 += 1; return; }
        if (!charId || !cn) {
          warnings.push(`[${year}] 国际服卡池出现国服没有的干员: ${en}（${startDate} ${rawType}）`);
          return;
        }
        if (!rarity) { dropped4 += 1; return; }   // 查不到星级：按 4★ 处理，不纳入
        if (seen.has(charId)) return;
        seen.add(charId);
        charIds.push(charId);
        upOperators.push({
          scCharName: cn.scName,  // 站点一律用中文名
          nameEn: en,             // 英文名留一份，便于排查
          charId,
          rarity,
          isLimited: cn.isLimited,
          isShop,                 // 只认 `store` 参数（见下方注释）
        });
      });

      if (!upOperators.length) {
        warnings.push(`[${year}] 干员全部被剔除，跳过: ${startDate} ${rawType}`);
        continue;
      }

      /* ⚠️ 国际服的 isShop **只**认 `store` 参数（只有 standard / kernel 有）。
         不要拿国服同池去补 —— 国服数据里也只有 double / classic 有进店标记，
         其余类型（限定 / 单六 / 联合行动…）本来就全是 false，两边保持一致。
         2026-10-01 说明：曾试过用「干员集合一致」照抄国服同池的 isShop，
         结果反而把 store 里正确的值覆盖掉，已移除。 */

      // —— 双五寻访 / 限定复刻：wiki.gg 分不出来，用国服同池反查
      const cnTwin = cnByOpSet.get(setKeyOf(charIds));
      let finalType = type;
      let forcedFive = false;
      let forcedLim = null;
      if (type === 'LIM_FROM_CN') {
        finalType = cnTwin && /^lim(cel|spr|sum)$/.test(cnTwin.type) ? cnTwin.type : null;
        if (!finalType) {
          warnings.push(`[${year}] 限定复刻找不到对应的国服池子，跳过: ${startDate} ${cell.name || ''}`);
          continue;
        }
        forcedLim = finalType;
      } else if (type === 'single' && cnFiveSets.has(setKeyOf(charIds))) {
        finalType = 'five';
        forcedFive = true;
      }

      /* ⚠️ 常驻中坚寻访 / 中坚甄选**2026-10-06 起不由本脚本产出** ——
         改由**官方解包数据**提供（`scripts/fetch-gamedata.mjs` → `data/banners_cla_<server>.json`，
         站点侧合并）。wiki.gg 的中坚数据会漏人（中坚甄选少一个六星）也会记错进店位，
         见 akGachaDocs/resource/官方解包数据（ArknightsGamedata）预研.md §4。 */
      if (finalType === 'classic' || finalType === 'clafes') continue;

      // —— ID
      const datePart = startDate.replace(/-/g, '');
      const name = String(cell.name || '').trim();
      let suffix;
      let displayName;
      if (SEQ_TYPES.includes(finalType) || finalType === 'double' || finalType === 'classic' || finalType === 'clafes') {
        const no = Number(String(cell.no || '').replace(/[^\d]/g, '')) || 0;
        suffix = pad4(no);
        displayName = {
          double: '常驻标准寻访', classic: '常驻中坚寻访', clafes: '中坚甄选',
          joint: '联合行动', stdfes: '定向甄选', mainfes: '前路回响',
        }[finalType] + no;
      } else {
        if (!name) {
          warnings.push(`[${year}] 缺卡池名，跳过: ${startDate} type=${rawType}`);
          continue;
        }
        suffix = initialsOf(name);
        displayName = name;
      }

      banners.push({
        id: `${datePart}_${finalType}_${suffix}`,
        name: displayName,
        type: finalType,
        startDate,
        endDate,
        /* ⚠️ 这里只剥掉排查用的 `nameEn`。
           2026-10-12 之前**连 `charId` 一起剥**（那个字段当时国服侧也没有、schema 里不存在）；
           现在三服 schema 统一要求 `upOperators` 带 `charId`，所以必须留着。 */
        /* 统一排序（2026-11-04）：口径见 `lib/banner-ops.mjs`，实装日**只认国服**，
           与国服 / 繁中服排出来的是同一个顺序。 */
        upOperators: sortUpOperators(
          upOperators.map(({ nameEn, ...rest }) => rest),
          { type: finalType, releaseOf: (o) => cnByCharId[o.charId]?.scReleaseDate ?? null },
        ),
        _forcedFive: forcedFive,
        /* 英文卡池名只在「限定 / 单六 / 双五」上有（这三类三服的叫法不同）；
           带序号的池子三服同名，没有英文名。下面统一处理时会把 name 换成国服中文名。 */
        _enName: nameGroupOf(finalType) ? (name || null) : null,
      });
    }
  }

  // —— 去重 & 排序
  const seen = new Map();
  for (const b of banners) {
    if (seen.has(b.id)) {
      warnings.push(`卡池 ID 重复（已跳过）: ${b.id} / ${b.name}`);
      continue;
    }
    seen.set(b.id, b);
  }
  const list = [...seen.values()].sort((a, b) =>
    a.startDate === b.startDate ? a.id.localeCompare(b.id) : a.startDate.localeCompare(b.startDate),
  );

  /* ---- 卡池名：限定 / 单六 / 双五 的 `name` 换成**国服中文名**，英文名存进 `enName` ----
     这三类的名字三服各不相同（国服「遗愿焰火」/ 国际服 "Cremation Last Wish"），
     站点展示的是国服名，所以按干员集合把 banners_sc.json 里的同一池子反查出来。
     带序号的池子（常驻标准寻访N / 联合行动N…）三服同名，scName 就是它自己、enName 为 null。
     ⚠️ 取用必须按开始日升序（list 已排好）—— 复刻池与首跑池干员集合相同，
        靠「第 N 次出现」配对；而 ID 里的名称段保持**英文名首字母**不变，不动它。 */
  const cnNameIndex = buildNameIndex(cnBanners);
  const matchCnName = createNameMatcher(cnNameIndex, { overflow: false });
  const cnNamed = [];
  const cnUnresolved = [];
  const out = {};
  for (const b of list) {
    const { _forcedFive, _enName, upOperators: ups } = b;
    const group = nameGroupOf(b.type);
    /* ⚠️ `b` 是本脚本内部的卡池对象（字段仍叫 `name`）—— 别写成 `b.scName`（undefined，
       会把输出的 `scName` 变成 undefined 而被 JSON.stringify 直接丢掉）。 */
    let scName = b.name;
    let hit = null;
    if (group) {
      hit = matchCnName(b);
      if (hit) {
        scName = hit.scName;
        cnNamed.push(`${b.id}「${_enName}」→ 国服 ${hit.id}「${scName}」`);
      } else {
        /* 国际服比国服慢，最新的几个池子还没上 —— 属于正常，保留英文名并记一条提示 */
        cnUnresolved.push(`${b.id} ${_enName || b.name}（${b.startDate}）`);
      }
    }
    out[b.id] = {
      /* ⚠️ 2026-10-12：`name` 已删（与 scName 重复），与国服 schema 对齐 */
      scName,
      enName: group ? (_enName || null) : null,
      type: b.type,
      startDate: b.startDate,
      endDate: b.endDate,
      upOperators: ups,
    };
    /* ⚠️ `rerunKind` / `canRerun` **只有单六寻访才有** —— 与国服 schema 保持一致
       （国服的 double 等类型就没这两个键）。自 2026-10-08 起这两个字段都由**官方解包**
       在国服侧推导（见 lib/op-activity.mjs），国际服**直接沿用国服对应池的值**：
       解包只有一套池子序列，按各服历史重算没有意义。
       实测支持「直接沿用国服」这个选择：国服 `single` 里只有 2 条「返场」，
       而 en 80 条**一条都不对应**。
       （卡池的 `actType` / `actName` 两个旧字段已于 2026-10-08 删除。） */
    if (b.type === 'single') {
      out[b.id].rerunKind = hit ? (hit.rerunKind ?? null) : null;
      out[b.id].canRerun = hit ? (hit.canRerun ?? false) : false;
    }
  }

  /* 复刻 / 返场池的「首发组」要沿用同系列首发池（2026-11-13，见 lib/banner-ops.mjs 文件头）——
     放在 `out` 建好之后，因为分组键用的是**反查后的国服名**（`scName`），比英文名可靠。 */
  const resorted = resortSeriesBanners(out, {
    releaseOf: (o) => cnByCharId[o.charId]?.scReleaseDate ?? null,
  });
  if (resorted) console.log(`  复刻池首发组归位：调整了 ${resorted} 个池的干员顺序`);

  // —— per-干员：enName / enClassicDate / enReleaseDate
  const firstBannerDate = new Map();   // charId → 第一次出现在国际服卡池的日期
  for (const b of list) {
    const cn = cnByCharId;
    for (const op of b.upOperators) {
      const cid = Object.keys(cn).find((k) => cn[k].scName === op.scCharName);
      if (!cid) continue;
      if (!firstBannerDate.has(cid)) firstBannerDate.set(cid, b.startDate);
    }
  }

  /* enReleaseDate：来自 wiki.gg 登场事件的 global 服 startTime（见 fetchEnReleaseDates，
     已是「最早事件」口径）。取不到的（少数没挂 event 的干员）退化为
     「第一次出现在国际服卡池」的日期。
     ⚠️ **开服干员另按 `EN_LAUNCH_DATE` 锚定**，不走上面两条（原因见常量注释）。 */
  let enReleaseFromWiki = 0;
  let enReleaseFromBanner = 0;
  let enReleaseAnchored = 0;
  for (const [cid, op] of Object.entries(cnOperators)) {
    /* ⚠️ 2026-10-12：`op.enName` 已改由 `fetch-data.mjs`（国服脚本）从官方解包 en 表写，
       本脚本不再碰它（原来取的是 wiki.gg 页面名；实测两者 222/222 逐字符相同）。 */
    const fromWiki = enReleaseDates[cid] || null;
    const fallback = firstBannerDate.get(cid) || null;
    op.enReleaseDate = fromWiki || fallback;
    /* 开服干员：国服开服当天就在 roster 里 → 国际服实装日 = 国际服开服日（见上方常量注释）。
       `scReleaseDate` 是 PRTS 的权威数据、必然存在，不依赖 wiki.gg 事件表是否完整。 */
    if (op.scReleaseDate && op.scReleaseDate <= CN_LAUNCH_DATE) {
      op.enReleaseDate = EN_LAUNCH_DATE;
      enReleaseAnchored += 1;
    } else if (fromWiki) enReleaseFromWiki += 1;
    else if (fallback) enReleaseFromBanner += 1;
  }

  /* ⚠️ enClassicDate = **转入中坚寻访的日期**，按 lib/mid-batches.mjs 的批次表 + 国际服实装日判定。
     2026-10-04 改：以前是「该干员第一次出现在中坚寻访卡池」—— 那是**轮换 UP** 的日期而不是
     转入日期（实测差 3~9 个月），且没轮到就 null；wiki.gg 没有这个字段，只能硬编码批次。 */
  const midOf = makeMidBatchResolver('en');
  const midChanged = [];
  for (const op of Object.values(cnOperators)) {
    const before = op.enClassicDate ?? null;
    op.enClassicDate = midOf(op);
    if (before !== op.enClassicDate) midChanged.push(`${op.scName} ${before || '—'} → ${op.enClassicDate || '—'}`);
  }

  // —— 输出：先判断「国际服自己的产出」有没有变化，再决定数据更新日要不要动
  const stab = (v) => JSON.stringify(v, null, 2) + '\n';
  const readOld = async (name) => {
    try { return await fs.readFile(path.join(OUT_DIR, name), 'utf8'); } catch { return null; }
  };
  const put = async (name, text) => {
    if (await readOld(name) === text) return false;
    if (!dry) await fs.writeFile(path.join(OUT_DIR, name), text, 'utf8');
    return true;
  };

  const selfChanged = (await readOld(`banners_${SERVER}.json`)) !== stab(out)
    || (await readOld('operators.json')) !== stab(cnOperators);

  // —— metadata：把 en 服务器的信息补上
  const metaPath = path.join(OUT_DIR, 'metadata.json');
  const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  const dates = list.map((b) => b.startDate).sort();
  const enEntry = meta.servers.find((s) => s.id === SERVER);
  if (enEntry) {
    enEntry.available = true;
    enEntry.bannerCount = list.length;
    enEntry.earliestBanner = dates[0] || null;
    enEntry.latestBanner = dates[dates.length - 1] || null;
  }
  if (!meta.sourcePages.includes('arknights.wiki.gg')) meta.sourcePages.push('arknights.wiki.gg');
  /* enGeneratedAt 只在**国际服自己的产出有变化**（或字段还空着）时更新，否则沿用旧值 ——
     与国服 generatedAt 同一个口径：CI 每周跑三次，没变就不该让「数据更新」白跳一天。 */
  if (selfChanged || !meta.enGeneratedAt) meta.enGeneratedAt = todayBeijing();

  const wrote = [];
  if (await put(`banners_${SERVER}.json`, stab(out))) wrote.push(`banners_${SERVER}.json`);
  if (await put('operators.json', stab(cnOperators))) wrote.push('operators.json');
  if (await put('metadata.json', stab(orderMeta(meta)))) wrote.push('metadata.json');

  // —— 报告
  const byType = {};
  for (const b of list) byType[b.type] = (byType[b.type] || 0) + 1;
  console.log('');
  console.log(`✓ 国际服卡池 ${list.length} 个（剔除 4★ 记录 ${dropped4} 条）`);
  console.log(`  剔除「5 倍权值」的往期限定干员 ${dropped5x} 条（limited = 2，不算 UP）`);
  console.log(`  时间范围 ${dates[0] || '—'} ~ ${dates[dates.length - 1] || '—'}`);
  console.log(`  各类型 ${JSON.stringify(byType)}`);
  const fiveList = list.filter((b) => b.type === 'five');
  console.log(`  双五寻访识别到 ${fiveList.length} 个：${fiveList.map((b) => `${b.id}(${b.name})`).join('、') || '（无）'}`);
  const withEnName = Object.values(out).filter((b) => b.enName).length;
  console.log(`  卡池名：${withEnName} 个带英文名（enName），其中 ${cnNamed.length} 个已按干员集合反查到国服中文名`);
  if (cnUnresolved.length) {
    console.log(`  ${cnUnresolved.length} 个限定/单六/双五池还没能对回国服（国际服更新更慢，属正常）：`);
    for (const x of cnUnresolved) console.log(`    ${x}`);
  }
  console.log(`  干员：enName ${Object.values(cnOperators).filter((o) => o.enName).length} 个 / `
    + `enReleaseDate ${enReleaseAnchored} 个锚定为开服日 + ${enReleaseFromWiki} 个来自 wiki.gg `
    + `+ ${enReleaseFromBanner} 个来自卡池 / `
    + `enClassicDate ${Object.values(cnOperators).filter((o) => o.enClassicDate).length} 个（批次表判定）`);
  /* 中坚批次核对（2026-10-04）：把每段名单打出来给作者过目 —— 批次表只有日期，
     「这段到底有哪些干员」靠这份输出确认；将来新增批次时同样先看这里。 */
  {
    const mid = dryRun('en', cnOperators);
    console.log('  中坚批次（按国际服实装日切段；名单也按实装日排序，首尾一眼可核对）：');
    for (const g of mid.groups) {
      console.log(`    ${g.date || '（未转入）'}（${g.kind === 'override' ? '特例' : '批次'} ${g.from || '开服'} ~ ${g.to}）`
        + ` ${g.count} 位 · 首 ${g.first} / 末 ${g.last}`);
      if (g.names.length) console.log(`      ${g.names.join('、')}`);
    }
    console.log(`    段外（已实装、非限定，但还没到批次）${mid.outside.length} 位`
      + (mid.outside.length ? `：${mid.outside.join('、')}` : ''));
    console.log(`    限定干员（按规则置 null）${mid.limited.length} 位`);
    console.log(`    与旧值不同 ${midChanged.length} 个`
      + (midChanged.length ? `：${midChanged.slice(0, 12).join('、')}${midChanged.length > 12 ? ' …' : ''}` : ''));
  }
  const withShop = list.filter((b) => b.upOperators.some((o) => o.isShop)).length;
  const storePools = list.filter((b) => b.type === 'double').length;
  console.log(`  isShop：${withShop} 个池子有进店标记（本脚本只产 double 带 store 参数，共 ${storePools} 个池子）`);
  if (skippedTypes.size) {
    console.log(`  忽略的类型：${[...skippedTypes].map(([k, v]) => `${k}×${v}`).join('、')}`);
  }
  if (skippedNoDate.length) {
    console.log(`  没有国际服日期而跳过 ${skippedNoDate.length} 条（预告池 / 国服独有）：`
      + `${skippedNoDate.slice(0, 5).join('、')}${skippedNoDate.length > 5 ? ' …' : ''}`);
  }
  console.log(`  ${dry ? '（--dry，未写盘）' : (wrote.length ? `实际写入：${wrote.join('、')}` : '数据无变化，未写盘')}`);

  if (warnings.length) {
    console.warn(`\n⚠ 共 ${warnings.length} 条警告：`);
    for (const w of warnings.slice(0, 40)) console.warn('  - ' + w);
    if (warnings.length > 40) console.warn(`  ... 其余 ${warnings.length - 40} 条已省略`);
  }
}

main().catch((e) => {
  console.error('✗ 抓取失败:', e.message);
  if (e.cause) console.error('  底层原因:', e.cause.code || e.cause.name, e.cause.message);
  process.exit(1);
});
