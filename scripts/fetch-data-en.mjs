#!/usr/bin/env node
/**
 * fetch-data-en.mjs
 * 从 **wiki.gg**（arknights.wiki.gg）抓取**国际服（Global / NA）**的寻访数据，
 * 产出 `data/banners_en.json`，并把国际服相关的字段写回 `data/operators.json` 与 `data/metadata.json`。
 *
 * 数据来源：
 *   1. `Category:Headhunting banners` 里的 `Headhunting/Banners/<年份>` 页面，
 *      每个卡池是页面里的一个 `{{Banners cell}}` 模板
 *      （⚠️ wiki 上也有写成 `{{Banners_cell}}` 下划线的，两种都要认，见 `CELL_OPEN`）。
 *   2. `{{Banners cell}}` 的关键参数：
 *        |type        卡池类型，见下方 TYPE_MAP
 *        |no          序号（常驻 / 中坚 / 联合行动 / 定向甄选 / 前路回响 用）
 *        |name        卡池英文名（限定 / 单六 / 双五 用）
 *        |cnstart / cnend        国服时间
 *        |globalstart / globalend 国际服时间   ← **国际服认这两个**
 *        |start / end 常驻标准寻访 / 常驻中坚寻访 / 中坚甄选 的国际服时间
 *                     （这三类国际服的池子与国服不同，wiki.gg 的页面里只列国际服的，
 *                       所以用 start/end 而不是 globalstart/globalend）
 *        |operators   干员英文名，逗号分隔（6★ 在前）
 *        |operators1 / operators2  甄选类池子拆成两段（1 = 六星池，2 = 五星池）
 *        |store       与 operators 一一对应的 0/1，1 = 可商店兑换
 *        |limited     与 operators 一一对应的 0/1/2（只有限定寻访有）：
 *                      0 = 普通 UP 干员   1 = 本期限定干员   2 = **5 倍权值**的往期限定干员
 *                    ⚠️ 值为 2 的那些**不算 UP**（用户口径）：它们只是复刻规则里
 *                       5 倍权重的往期限定，wiki.gg 却把它们和真正的 UP 并排写在
 *                       `operators` 里。**必须剔掉** —— 否则限定寻访会多出 2~3 个
 *                       六星，站点侧（限定干员一律排除）和「双五/单六」的集合反查都会错。
 *   3. charId 映射：`Operators ⋈ OperatorFiles` **一次查齐**（英文名 + 星级 + F.id），
 *      卡池数据里只有英文名，而站点一律用中文名索引，所以这个映射是关键。
 *      （此前是「Operators 清单 + 分批抓干员页 wikitext」，仅映射就要 ~9 次请求，已合并。）
 *   4. 卡池名：限定寻访 / 单六寻访 / 双五寻访的 `|name` 是**英文名**，
 *      写成 `enName`；`name` / `scName` 用**国服中文名**（按干员集合反查 banners_sc.json，
 *      见 lib/banner-names.mjs）。带序号的池子（常驻 / 中坚 / 联合行动…）三服同名，
 *      `enName` 为 null。ID 里的名称段仍是**英文名首字母**，不随改名变动（ID 要保持稳定）。
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
 *
 * ⚠️ 国际服比国服更新慢，所以不会出现「国际服有、国服没有」的干员。
 *    遇到对不上的干员（多半是 4★）会被剔掉并计入警告。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { orderMeta } from './lib/meta.mjs';
import { buildNameIndex, createNameMatcher, nameGroupOf } from './lib/banner-names.mjs';
import { makeMidBatchResolver, dryRun } from './lib/mid-batches.mjs';
import './lib/http.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'data');

const WIKI = 'https://arknights.wiki.gg/api.php';
const HEADERS = {
  'User-Agent': 'akGachaData/1.0 (personal data site; +https://github.com/Yjun233/akGachaData)',
  Accept: 'application/json',
};

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

async function api(params, { tries = 5 } = {}) {
  const url = `${WIKI}?${new URLSearchParams({ ...params, format: 'json', formatversion: '2' })}`;
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      const c = e && e.cause;
      const detail = c ? `${c.code || c.name || ''} ${c.message || ''}`.trim() : '';
      console.error(`  · 第 ${i + 1}/${tries} 次请求失败: ${e.message}${detail ? ' ← ' + detail : ''}`);
      await sleep(1200 * (i + 1));
    }
  }
  const c = lastErr && lastErr.cause;
  const tail = c ? `${c.code || c.name || ''} ${c.message || ''}`.trim() : '';
  throw new Error(`请求失败: ${lastErr && lastErr.message}${tail ? ' ← ' + tail : ''}`);
}

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

/**
 * 一次 cargoquery 拿齐干员映射（Operators ⋈ OperatorFiles）：
 *   英文名（O._pageName）+ 星级（O.rarity）+ charId（F.id）。
 * 取代原先「Operators 全量清单 + 分批抓干员页 wikitext」两步（后者要 ~9 次请求）。
 *
 * ⚠️ 行粒度**不是**一干员一行：多形态干员（阿米娅本体/升变、精英干员的
 *    ac / Stronghold Protocol 变体）在 OperatorFiles 里有多个 charId 的行，
 *    还有空页名（正义骑士号这类没有干员页的）与空 charId（新公布未实装）的杂行。
 *    所以：byCharId 收**所有**有 charId 的行（4★ 靠它识别星级、静默剔除）；
 *    调用方建「英文名 → charId」映射时必须让**本体行**（charId 在 operators.json
 *    里）优先占位，变体行只补空位 —— 否则阿米娅会解析到升变形态的 charId
 *    （2026-10-03 实测 482 行）。
 */
async function fetchOperatorMap(cnOperators) {
  console.log('· 抓取 wiki.gg 干员映射（Operators ⋈ OperatorFiles）...');
  const byCharId = new Map();
  for (let offset = 0; offset < 4000; offset += 500) {
    const json = await api({
      action: 'cargoquery',
      tables: 'Operators=O,OperatorFiles=F',
      fields: 'O._pageName=page,O.rarity=rarity,F.id=charId',
      join_on: 'F.name=O.name',
      limit: 500,
      offset,
    });
    const rows = json.cargoquery || [];
    if (!rows.length) break;
    for (const r of rows) {
      const { page, rarity, charId } = r.title;
      if (!page || !charId || byCharId.has(charId)) continue;
      byCharId.set(charId, {
        enName: page,
        rarity: rarity === '' ? null : Number(rarity),
      });
    }
    if (rows.length < 500) break;
  }
  console.log(`  → ${byCharId.size} 条 charId 映射`);
  return byCharId;
}

// ---------------------------------------------------------------- 卡池

/** 抓各年份的卡池页 */
async function fetchBannerPages() {
  console.log('· 抓取卡池页（Headhunting/Banners/<年份>）...');
  const pages = {};
  for (const y of YEAR_PAGES) {
    const json = await api({ action: 'parse', page: `Headhunting/Banners/${y}`, prop: 'wikitext' });
    const text = json.parse?.wikitext || '';
    if (text) pages[y] = text;
    console.log(`  ${y}: ${text.length} 字符`);
  }
  return pages;
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
    const json = await api({
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
  const cnByName = new Map(Object.values(cnOperators).map((o) => [o.name, o]));
  /** charId → 国服卡池 */
  const cnByCharId = cnOperators;

  /** 国服卡池的「干员集合」→ 卡池，用于把国际服的同名池子对回国服（借它的 isShop） */
  const setKeyOf = (charIds) => [...new Set(charIds)].sort().join('|');
  const cnByOpSet = new Map();
  for (const [id, b] of Object.entries(cnBanners)) {
    const ids = b.upOperators.map((o) => cnByName.get(o.name)?.charId).filter(Boolean);
    if (ids.length === b.upOperators.length) cnByOpSet.set(setKeyOf(ids), { id, ...b });
  }
  /** 国服「双五寻访」的干员集合 → 国际服的同一批池子靠它认出来 */
  const cnFiveSets = new Map();
  const cnFiveNames = [];
  for (const [id, b] of Object.entries(cnBanners)) {
    if (b.type !== 'five') continue;
    const ids = b.upOperators.map((o) => cnByName.get(o.name)?.charId).filter(Boolean);
    if (ids.length) {
      cnFiveSets.set(setKeyOf(ids), id);
      cnFiveNames.push(`${id} ${b.name}`);
    }
  }
  console.log(`· 国服数据：干员 ${Object.keys(cnOperators).length} / 卡池 ${Object.keys(cnBanners).length}`);
  console.log(`  国服「双五寻访」共 ${cnFiveSets.size} 个：${cnFiveNames.join('、')}`);

  const byCharId = await fetchOperatorMap(cnOperators);
  /** 英文名 → charId（本体行 —— charId 在 operators.json 里 —— 优先占位，变体行只补空位） */
  const byEnName = new Map();
  for (const [charId, v] of byCharId) {
    if (cnOperators[charId]) byEnName.set(normKey(v.enName), charId);
  }
  for (const [charId, v] of byCharId) {
    const key = normKey(v.enName);
    if (!byEnName.has(key)) byEnName.set(key, charId);
  }

  const pages = await fetchBannerPages();
  const enReleaseDates = await fetchEnReleaseDates();

  const warnings = [];
  const skippedTypes = new Map();
  const banners = [];
  let dropped4 = 0;
  let dropped5x = 0;

  for (const [year, text] of Object.entries(pages)) {
    /* 有没被识别出来的 {{Banners…}} 写法就直接报出来（漏一条就是漏一个卡池） */
    const unmatched = unmatchedBannerTemplates(text);
    if (unmatched.length) {
      warnings.push(`[${year}] 有 ${unmatched.length} 个 {{Banners…}} 模板没被识别（wiki 换写法了？）：`
        + unmatched.slice(0, 4).join(' / '));
    }
    for (const cell of parseCells(text)) {
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
        warnings.push(`[${year}] 没有国际服开始日期，跳过: type=${rawType} name=${cell.name || ''}`);
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
          name: cn.name,          // 站点一律用中文名
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
        upOperators: upOperators
          .map(({ charId, nameEn, ...rest }) => rest)
          .sort((a, b) => (b.rarity - a.rarity) || Number(a.isShop) - Number(b.isShop)),
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
    let scName = b.name;
    let hit = null;
    if (group) {
      hit = matchCnName(b);
      if (hit) {
        scName = hit.name;
        cnNamed.push(`${b.id}「${_enName}」→ 国服 ${hit.id}「${scName}」`);
      } else {
        /* 国际服比国服慢，最新的几个池子还没上 —— 属于正常，保留英文名并记一条提示 */
        cnUnresolved.push(`${b.id} ${_enName || b.name}（${b.startDate}）`);
      }
    }
    out[b.id] = {
      name: scName,
      scName,
      enName: group ? (_enName || null) : null,
      type: b.type,
      startDate: b.startDate,
      endDate: b.endDate,
      upOperators: ups,
      /* ---- `actType` / `actName`（卡池所属活动）**不是抓来的**，是从国服对应池沿用过来的
         （用户 2026-10-06 定）：这两个字段反映**国服口径的上架进度**，国际服落后于国服，
         按各服历史重算没有意义。只有限定 / 单六 / 双五三类能反查得到（`group` 非空），
         其余类型恒为 null —— 但**键必须存在**（与国服 schema 一致，站点侧会查）。 */
      actType: hit ? (hit.actType ?? null) : null,
      actName: hit ? (hit.actName ?? null) : null,
    };
    /* ⚠️ `rerunKind` / `canRerun` **只有单六寻访才有** —— 与国服 schema 保持一致
       （国服的 double 等类型就没这两个键）。实测支持「直接沿用国服」这个选择：
       国服 `single` 里只有 2 条「返场」，而 en 80 条**一条都不对应**。 */
    if (b.type === 'single') {
      out[b.id].rerunKind = hit ? (hit.rerunKind ?? null) : null;
      out[b.id].canRerun = hit ? (hit.canRerun ?? false) : false;
    }
  }

  // —— per-干员：enName / enClassicDate / enReleaseDate
  const firstBannerDate = new Map();   // charId → 第一次出现在国际服卡池的日期
  for (const b of list) {
    const cn = cnByCharId;
    for (const op of b.upOperators) {
      const cid = Object.keys(cn).find((k) => cn[k].name === op.name);
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
    const info = byCharId.get(cid);
    op.enName = info?.enName ?? null;
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
    if (before !== op.enClassicDate) midChanged.push(`${op.name} ${before || '—'} → ${op.enClassicDate || '—'}`);
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
