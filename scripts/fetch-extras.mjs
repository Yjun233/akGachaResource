/**
 * fetch-extras.mjs
 * 从 PRTS Wiki 抓取**国服**的「干员皮肤 / 干员密录 / 干员模组」数据，生成静态 JSON。
 *
 * 输出（data/）：
 *   skins.json     干员时装：含**复刻在内**的所有上架窗口 + 获取途径
 *   memoirs.json   干员密录：第几批 + 推出日期
 *   modules.json   干员模组：第几个 + 推出日期
 *
 * ⚠️ 口径的**权威说明**在 akGachaDocs/resource/干员皮肤密录模组数据爬取预研.md
 *    （该文档记录了所有实测数字与用户拍板项）。本文件只实现它，不再重复论证。
 *
 * 关键口径（改代码前先读预研文档）：
 *  1. **只收 `operators.json` 里的干员**（= 参与过寻访 UP 的那 230 位）。
 *     注意它**不是「所有 5/6 星」**，阿米娅 / 灰烬 / 战车 / 魔王 等都不在表里。
 *  2. **「回顾时间N」整条不要**。
 *  3. 剔除说明里含 `凭证交易所` / `记录修复` 的窗口。
 *  4. 剔除「危机合约」的**长窗口 / 常驻**（说明含 危机合约/机密圣所/结晶圣所 且 无终点或 >365 天）。
 *  5. 剩下的「无终点（XXXX以后）」= 常驻 → `end = start + 14` 且记 `longTime: true`。
 *     （用户明确：只为讨论与 UP 的关联性，这里数据不真实也无妨。）
 *  6. **只存年月日**，丢掉时分。
 *  7. 密录：把 `stories` **按时间分组**，同一时间的一组算「一批」，组内名字用 `|` 连成 `name`。
 *  8. 模组：按批次 `time` 升序给每位干员编号（`seq` = 第几个）。
 *  9. **「合作款」（`isCrossover`）按皮肤所在的系列页判定** —— 即 `时装回廊/合作款`，
 *     不是拿 `series` 去比对品牌名清单（实测 25 个系列页互不重叠，故无歧义；
 *     这样以后新增联动品牌也不用改代码）。
 *
 * ⚠️ 数据源是**人工维护**的 wiki，会有笔误（实测 4 处「结束日早于开始日」）。
 *    本脚本**只记 warning、保留原样，不自动「修」** —— 发现疑似写错报给用户（他有 PRTS 编辑权限）。
 *
 * 用法：
 *   node scripts/fetch-extras.mjs           抓取并写盘（内容没变则不写）
 *   node scripts/fetch-extras.mjs --dry     只打印统计，不写盘
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './lib/http.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'data');
const DRY = process.argv.includes('--dry');

/* 「合作款」在 PRTS 里是**时装回廊下的一个系列页**（不是从「时装组名称」派生的分类）。
   实测：25 个系列页互不重叠（合计 520 套、无一套出现在两页）→ 按「皮肤所在页面」判定无歧义。
   该页里都是联动皮肤（肯德基 / 彩虹六号：围攻 / 三丽鸥家族 / 小马宝莉 / 女神异闻录３ …）。
   ⚠️ 别改成按 series 白名单硬编码 —— 以后新增联动品牌就要改代码。 */
const CROSSOVER_PAGE = '时装回廊/合作款';

const API = 'https://prts.wiki/api.php';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  Referer: 'https://prts.wiki/',
  Origin: 'https://prts.wiki',
};
const BEIJING_OFFSET_MS = 8 * 3600 * 1000;
const todayBeijing = () => new Date(Date.now() + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const warnings = [];
const warn = (msg) => warnings.push(msg);

/* ---------------------------------------------------------------- HTTP */

/** 带重试的 API 调用（PRTS 偶尔 5xx / 网络抖动；不带重试会静默少数据） */
async function fetchJson(params, tries = 4) {
  const url = `${API}?${new URLSearchParams({ format: 'json', ...params })}`;
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(`API error: ${json.error.info || JSON.stringify(json.error)}`);
      return json;
    } catch (e) {
      if (i === tries - 1) throw new Error(`请求失败 (${JSON.stringify(params).slice(0, 140)}): ${e.message}`);
      await sleep(600 * (i + 1));
    }
  }
  return {};
}

/** 取页面原文 */
const fetchWikitext = async (page) => (await fetchJson({ action: 'parse', page, prop: 'wikitext' })).parse.wikitext['*'];

/* ------------------------------------------------------- 文本清洗工具 */

/** 剥掉 `<ref>…</ref>` 脚注 —— ⚠️ 脚注里也常含「…以后」，不剥会把有限窗口误判成常驻 */
const stripRef = (v) => String(v ?? '').replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '').replace(/<ref[^>]*\/>/gi, '');

/** 剥模板 / 加粗 / 换行，得到可搜索的纯文本（wiki 链接保留显示文本） */
const plain = (v) => String(v ?? '')
  .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1')
  .replace(/\[\[([^\]]*)\]\]/g, '$1')
  .replace(/\{\{[^}]*\}\}/g, ' ')
  .replace(/<br\s*\/?>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/'{2,}/g, '')
  .replace(/\s+/g, ' ')
  .trim();

/** 只保留链接的显示文本（用于归一化「获得途径」），模板一律去掉 */
const linkText = plain;

/**
 * 按**行首 `{{`** 切模板块（对「多行结尾」与「行内结尾」两种写法都成立）。
 * ⚠️ 不要用 `/\{\{X([\s\S]*?)\n\}\}/` 这种「`\n}}` 收尾」的正则 —— 遇到行内结尾会**静默漏抓**。
 */
function splitBlocks(text, tplName) {
  return String(text)
    .split(/\n\{\{/)
    .filter((s) => s.startsWith(`${tplName}\n`) || s.startsWith(`${tplName}|`))
    .map((s) => s.slice(tplName.length).replace(/\}\}\s*$/, '').replace(/^\n/, ''));
}

/** 把 `|键 = 值` 行解析成对象 */
function parseParams(body) {
  const out = {};
  for (const line of String(body).split('\n')) {
    const m = /^\|([^=]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1].trim()] = m[2].trim();
  }
  return out;
}

/* ------------------------------------------------------------- 时间解析 */

const pad2 = (s) => String(s).padStart(2, '0');
const DATE_RE = /(\d{4})\s*[年/\-.]\s*(\d{1,2})\s*[月/\-.]\s*(\d{1,2})/g;
const addDays = (date, n) => {
  const t = Date.parse(`${date}T00:00:00Z`) + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
};
/**
 * Unix 秒 → `YYYY-MM-DD`（**按北京时间**）。
 * ⚠️ 不能直接 `new Date(t*1000).toISOString().slice(0,10)` —— 那是 UTC。
 * 这些时间戳的北京时间是 04:00 / 16:00，其中 04:00 对应 UTC **前一天 20:00**，
 * 用 UTC 取日期会整体早一天，而且会把「同一天上线」的密录拆开（实测会少算多批的干员数）。
 */
const unixToBeijingDate = (sec) => new Date(sec * 1000 + BEIJING_OFFSET_MS).toISOString().slice(0, 10);

/**
 * 解析一个「上架窗口」字段的值。
 * 实测形态：`A 04:00 ~ <br>B 03:59` / `A 16:00以后`（无终点） / 完全没有。
 * 返回 null = 这个字段不可用。
 */
function parseWindow(value) {
  const v = stripRef(value);
  if (!v.trim()) return null;
  const bare = v.replace(/\{\{[^}]*\}\}/g, ' ').replace(/<br\s*\/?>/gi, ' ');
  const dates = [...bare.matchAll(DATE_RE)].map((m) => `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`);
  const open = /以后/.test(v);
  /* 说明文字 = 括号里的那句（如「危机合约：机密圣所复刻兑换」「[[墟]]往期复刻」）；
     ⚠️ 判「剔不剔」用的是 `raw`（整个值），见 dropReason。 */
  const note = [...v.matchAll(/[（(]([^）)]*)[）)]/g)].map((x) => plain(x[1])).filter(Boolean).join(' / ').slice(0, 120);
  const span = dates.length >= 2 ? Math.round((Date.parse(dates[1]) - Date.parse(dates[0])) / 86400000) : null;
  return { dates, open, note, span, raw: v };
}

/**
 * 该窗口要不要剔除（口径见文件头 2~4）。
 * 判据用**剥了 `<ref>` 的原始值**做关键词匹配。
 */
function dropReason(kind, w) {
  if (kind === '回顾') return '回顾';
  if (/凭证交易所|记录修复/.test(w.raw)) return '凭证交易所/记录修复';
  if (/(危机合约|机密圣所|结晶圣所)/.test(w.raw) && (w.open || w.span === null || w.span > 365)) {
    return '危机合约长窗/常驻';
  }
  return null;
}

/** 窗口 → 落盘对象；返回 null = 没有可用起点（跳过） */
function toShelfEntry(skinName, kind, seq, w) {
  const start = w.dates[0];
  if (!start) {
    warn(`[皮肤] ${skinName} 的「${kind}」窗口没有可解析的日期：${w.raw.slice(0, 80)}`);
    return null;
  }
  let end;
  let longTime = false;
  if (w.dates.length >= 2 && !w.open) {
    end = w.dates[1];
    if (end < start) {
      /* 实测有 4 处这种笔误（wiki 数据错）。**保留原样、只告警**，不自动「修」。 */
      warn(`[皮肤] ${skinName} 的「${kind}」结束日早于开始日（疑似 wiki 笔误，保留原样）：${start} → ${end}`);
    }
  } else {
    /* 无终点（常驻）→ end = start + 14，标 longTime（用户定的口径） */
    end = addDays(start, 14);
    longTime = true;
  }
  const item = { kind, start, end, note: w.note, longTime };
  if (kind === '复刻') item.seq = seq;
  return item;
}

/* --------------------------------------------------- 「获得途径」归一化 */

/**
 * 8 类归一化（顺序即优先级 —— ⚠️「特典兑换/采购中心」这类**组合途径**要命中前者）。
 * 统计口径用 `obtain[0]`（主类别）。
 */
const OBTAIN_RULES = [
  [/特典兑换|特典获得/, '特典'],
  [/采购中心/, '源石购买'],
  [/活动获得/, '活动赠送'],
  [/机密圣所|结晶圣所|危机合约/, '危机合约'],
  [/集成战略/, '集成战略'],
  [/生息演算/, '生息演算'],
  [/线下礼包/, '联名线下'],
];
function normalizeObtain(raw) {
  const t = linkText(raw);
  const hit = [];
  for (const [re, label] of OBTAIN_RULES) if (re.test(t) && !hit.includes(label)) hit.push(label);
  return { obtain: hit.length ? hit : ['其他'], obtainRaw: t || null };
}

/* --------------------------------------------------------------- 主流程 */

async function main() {
  const operators = JSON.parse(await fs.readFile(path.join(OUT_DIR, 'operators.json'), 'utf8'));
  const opNames = new Set(Object.values(operators).map((o) => o.name));
  console.log(`· 本站干员表 ${opNames.size} 位（只收这些干员的皮肤 / 密录 / 模组）`);

  /* ---------------- 1. 皮肤 ---------------- */
  const pages = [];
  let cont = {};
  do {
    const j = await fetchJson({ action: 'query', list: 'allpages', apprefix: '时装回廊/', aplimit: 200, ...cont });
    for (const p of j.query?.allpages || []) pages.push(p.title);
    cont = j.continue || {};
  } while (cont.apcontinue);
  console.log(`· 时装回廊 ${pages.length} 个系列页`);

  const rawSkins = [];
  for (const page of pages) {
    const text = await fetchWikitext(page);
    const blocks = splitBlocks(text, '干员时装');
    /* 兜底断言：原文出现次数 vs 解析条数（切块正则写错 / 页面改版时会立刻暴露） */
    const appeared = (text.match(/\{\{干员时装/g) || []).length;
    if (appeared !== blocks.length) {
      warn(`[皮肤] ${page}：原文出现 ${appeared} 个 {{干员时装}}，只解析出 ${blocks.length} 个`);
    }
    for (const b of blocks) {
      const params = parseParams(b);
      /* 记下**来自哪个系列页** —— 目前只用于判定「合作款」（见 CROSSOVER_PAGE）。
         落盘时不会输出 `__page`（输出对象是显式构造的）。 */
      params.__page = page;
      rawSkins.push(params);
    }
    await sleep(120);
  }

  const stat = {
    total: 0,
    /* 两套计数：`all` = 全部 520 套（对预研文档的黄金值），`site` = 只留本站干员后 */
    all: { windows: 0, dropped: { 回顾: 0, '凭证交易所/记录修复': 0, '危机合约长窗/常驻': 0 }, kept: 0 },
    site: { windows: 0, dropped: { 回顾: 0, '凭证交易所/记录修复': 0, '危机合约长窗/常驻': 0 }, kept: 0 },
  };
  const skins = [];
  const allKeptSkus = new Set();
  const siteKeptSkus = new Set();
  for (const p of rawSkins) {
    stat.total += 1;
    const name = plain(p['干员名']);
    const sku = `${name}/${plain(p['时装名'])}`;
    const isSite = opNames.has(name);
    const rows = [
      ['首发', '限时时间', null],
      ...Array.from({ length: 20 }, (_, i) => ['复刻', `复刻时间${i + 1}`, i + 1]),
      /* 「回顾」口径上整条不要（dropReason 一律返回 '回顾'）。这里**仍然读进来**只为两件事：
         ① 让打印出来的「全量窗口数」能对上预研文档的黄金值（1471 = 首发+复刻+回顾）；
         ② 万一 wiki 以后把回顾拆成更多字段，计数变了能立刻看见。 */
      ...Array.from({ length: 5 }, (_, i) => ['回顾', `回顾时间${i + 1}`, null]),
    ];
    const onShelf = [];
    let keptHere = 0;
    for (const [kind, key, seq] of rows) {
      const w = parseWindow(p[key]);
      if (!w) continue;
      const why = dropReason(kind, w);
      /* 两套计数都要走一遍判定（这样打印出来的才是**可核对的全量链**） */
      if (isSite) stat.site.windows += 1;
      stat.all.windows += 1;
      if (why) {
        if (isSite) stat.site.dropped[why] += 1;
        stat.all.dropped[why] += 1;
        continue;
      }
      keptHere += 1;
      if (isSite) stat.site.kept += 1;
      stat.all.kept += 1;
      if (!isSite) continue;
      const entry = toShelfEntry(sku, kind, seq, w);
      if (entry) onShelf.push(entry);
    }
    if (keptHere) { allKeptSkus.add(sku); if (isSite) siteKeptSkus.add(sku); }
    if (!isSite) continue; // 口径 1：只落盘本站干员
    onShelf.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    const { obtain, obtainRaw } = normalizeObtain(p['获得途径']);
    const group = plain(p['时装组名称']) || null;
    const priceNum = Number((/^(\d+)/.exec(plain(p['价格'])) || [])[1]);
    skins.push({
      char: name,
      skinIndex: Number(p['皮肤序号']) || null,
      name: plain(p['时装名']),
      group,
      series: group ? group.split('/')[0] : null,
      /* 是否「合作款」（联动皮肤）：以**位于时装回廊/合作款页**为准，不靠 series 猜品牌名 */
      isCrossover: p.__page === CROSSOVER_PAGE,
      obtain,
      obtainRaw,
      firstPrice: Number.isFinite(priceNum) ? priceNum : null,
      firstPriceUnit: plain(p['价格单位']) || null,
      onShelf,
      dynamic: Boolean(p['动态形象']),
      warnings: [],
    });
  }

  /* ---------------- 2. 密录 ---------------- */
  const memoirJson = JSON.parse(await fetchWikitext('干员密录一览/time'));
  const memoirs = [];
  for (const [char, v] of Object.entries(memoirJson)) {
    if (!opNames.has(char)) continue;
    const stories = (v.stories || []).map((s) => ({ name: plain(s.story), date: unixToBeijingDate(s.time) }));
    /* 口径 7：**按时间分组**，同一时间的一组算「一批」，组内名字用 `|` 连接 */
    const groups = [];
    for (const s of stories) {
      const last = groups[groups.length - 1];
      if (last && last.date === s.date) last.names.push(s.name);
      else groups.push({ date: s.date, names: [s.name] });
    }
    if (!groups.length) continue;
    memoirs.push({
      char,
      rarity: v.rarity ?? null,
      batches: groups.map((g, i) => ({ batch: i + 1, name: g.names.join('|'), date: g.date })),
      releaseDate: groups[0].date,
    });
  }
  memoirs.sort((a, b) => (a.releaseDate < b.releaseDate ? -1 : a.releaseDate > b.releaseDate ? 1 : 0));

  /* ---------------- 3. 模组 ---------------- */
  const modJson = JSON.parse(await fetchWikitext('干员模组一览/time'));
  const flat = [];
  for (const batch of modJson) {
    const date = unixToBeijingDate(batch.time);
    for (const e of batch.equips || []) flat.push({ char: plain(e.char), name: plain(e.name), date });
  }
  const byChar = new Map();
  for (const m of flat) {
    if (!opNames.has(m.char)) continue; // 口径 1
    if (!byChar.has(m.char)) byChar.set(m.char, []);
    byChar.get(m.char).push(m);
  }
  const modules = [];
  for (const [char, list] of byChar) {
    list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    list.forEach((m, i) => modules.push({ char, seq: i + 1, name: m.name, date: m.date }));
  }
  modules.sort((a, b) => (a.char < b.char ? -1 : a.char > b.char ? 1 : a.seq - b.seq));

  /* ---------------- 统计 ---------------- */
  const obtainDist = {};
  for (const s of skins) obtainDist[s.obtain[0]] = (obtainDist[s.obtain[0]] || 0) + 1;
  const longCount = skins.reduce((a, s) => a + s.onShelf.filter((w) => w.longTime).length, 0);
  const batchCount = memoirs.reduce((a, m) => a + m.batches.length, 0);
  const multiBatch = memoirs.filter((m) => m.batches.length > 1).length;

  console.log('\n· 皮肤');
  console.log(`  原文解析 ${stat.total} 套 / 窗口 ${stat.all.windows}`);
  console.log(`  ├ 全量剔除：回顾 ${stat.all.dropped['回顾']} / 凭证交易所·记录修复 ${stat.all.dropped['凭证交易所/记录修复']} / 危机合约长窗·常驻 ${stat.all.dropped['危机合约长窗/常驻']} → 保留 ${stat.all.kept} 个窗口 / ${allKeptSkus.size} 套`);
  console.log(`  └ 只留本站干员：从 ${stat.total} 套筛出 ${skins.length} 套（其中 ${siteKeptSkus.size} 套有≥1 个窗口）/ 保留 ${stat.site.kept} 个窗口`);
  console.log(`  其中 longTime（end = start + 14）：${longCount}`);
  console.log(`  其中「合作款」（联动皮肤）：${skins.filter((s) => s.isCrossover).length} 套`);
  console.log(`  获取途径分布（按主类别）：${JSON.stringify(obtainDist)}`);
  console.log('· 密录');
  console.log(`  ${memoirs.length} 位 / ${batchCount} 批（其中 ${multiBatch} 位是多批）`);
  console.log('· 模组');
  console.log(`  ${byChar.size} 位 / ${modules.length} 个`);

  if (DRY) {
    console.log('\n[dry] 未写盘。黄金值参考：皮肤 520 → 1471 → 1190 → 807；密录 333 → 174；模组 499 → 326');
    if (warnings.length) {
      console.warn(`\n⚠ ${warnings.length} 条警告：`);
      for (const w of warnings.slice(0, 30)) console.warn('  - ' + w);
      if (warnings.length > 30) console.warn(`  ... 其余 ${warnings.length - 30} 条已省略`);
    }
    return;
  }

  /* ---------------- 落盘（内容不变则不写） ---------------- */
  await fs.mkdir(OUT_DIR, { recursive: true });
  const SRC = 'https://prts.wiki';
  const stab = (v) => JSON.stringify(v, null, 2) + '\n';
  const readOld = async (name) => { try { return await fs.readFile(path.join(OUT_DIR, name), 'utf8'); } catch { return null; } };
  const put = async (name, text) => {
    if (await readOld(name) === text) return false;
    await fs.writeFile(path.join(OUT_DIR, name), text, 'utf8');
    return true;
  };

  /* ⚠️ `generatedAt` **不能无脑写今天** —— CI 每周定时跑，内容没变却把日期往前推，
     就会产生「内容其实没变」的空提交。所以比内容时**把它剔掉**，
     只有该文件内容真的变了才推进日期，否则沿用旧文件里的日期。
     （与 fetch-data.mjs 的处理方式一致。） */
  const OUT_FILES = [
    ['skins.json', 'skins', skins],
    ['memoirs.json', 'memoirs', memoirs],
    ['modules.json', 'modules', modules],
  ];
  const today = todayBeijing();
  const finals = [];
  for (const [name, key, arr] of OUT_FILES) {
    const raw = await readOld(name);
    let prev = null;
    try { prev = raw ? JSON.parse(raw) : null; } catch { prev = null; } // 旧文件坏了就当成「有变化」
    /* 两边都按**同样的键序**构造，否则 JSON 字符串会因顺序不同而误判成「变了」 */
    const nextCore = { source: SRC, [key]: arr };
    const prevCore = prev ? { source: prev.source ?? null, [key]: prev[key] ?? null } : null;
    const same = prevCore !== null && JSON.stringify(prevCore) === JSON.stringify(nextCore);
    const generatedAt = same ? (prev.generatedAt || today) : today;
    finals.push([name, stab({ generatedAt, ...nextCore })]);
  }

  const wrote = [];
  for (const [name, text] of finals) if (await put(name, text)) wrote.push(name);

  if (warnings.length) {
    console.warn(`\n⚠ 共 ${warnings.length} 条警告：`);
    for (const w of warnings.slice(0, 40)) console.warn('  - ' + w);
    if (warnings.length > 40) console.warn(`  ... 其余 ${warnings.length - 40} 条已省略`);
  }
  console.log(wrote.length ? `\n✓ 已写入：${wrote.join('、')}` : '\n✓ 三个文件内容都没变化，未写盘');
  /* ⚠️ 刻意**不动 metadata.json**：它的键由另外三个脚本各写一部分，本脚本插一个键
     会被它们下次运行抹掉（要改三个脚本才稳）。每个文件自带 generatedAt 就够了。 */
}

main().catch((e) => { console.error('✗ 失败：', e); process.exitCode = 1; });
