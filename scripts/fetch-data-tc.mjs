#!/usr/bin/env node
/**
 * fetch-data-tc.mjs
 * 从**金山文档在线表格**（AirScript webhook）生成**繁中服（台服 / TW）**数据。
 *
 * 繁中服没有 PRTS / wiki.gg 那样的数据站，数据源是人工维护的金山在线表格。
 * 本脚本通过 AirScript webhook **联网**逐格读取三张表 —— **不再经过 xlsx**
 * （导出会把日期型单元格整列吞掉，那是旧方案的根因；细节见 scripts/lib/airscript.mjs）。
 *
 * 产出：
 *   data/banners_tc.json        繁中服卡池表
 *   回填 data/operators.json     tcReleaseDate / tcClassicDate
 *   回填 data/metadata.json      tcGeneratedAt + 繁中服那条 server 记录
 *
 * 卡池名：`name` / `scName` 都是**国服中文名**（繁中服与国服同名，脚本里
 * 靠干员集合反查 banners_sc.json 拿到的就是这个）；`enName` 是国际服英文名，
 * 从 banners_en.json 反查，没有的（带序号的池子三服同名）为 null。
 * 反查规则见 scripts/lib/banner-names.mjs。
 *
 * 用法：
 *   node scripts/fetch-data-tc.mjs           # 读表 + 生成并写盘（内容没变则不写）
 *   node scripts/fetch-data-tc.mjs --dry     # 只读表、解析与统计，不写盘
 *
 * 凭证（脚本令牌 / file_id / script_id）的解析顺序见 scripts/lib/airscript.mjs：
 * `AIRSCRIPT_TOKEN` 是**密钥**，本地放已 gitignore 的 `scripts/.airscript_token`，
 * CI 走 GitHub Secrets；file_id / script_id 只是文档标识，允许内置默认值。
 *
 * ---------------------------------------------------------------- 表格结构
 *
 * 【繁中轮换记录】两类记录**横着并排**，同一行的两边日期互不相干，必须当成两个独立列表：
 *   · 常驻标准寻访（B~H 列）：B 开始 / C 结束 / D 六星进店 / E 六星陪跑 /
 *     F 五星进店 / G、H 五星陪跑        → 2 六星 + 3 五星，进店标记 =「六星进店」「五星进店」
 *   · 限时寻访（K~X 列）：K 开始 / L 结束 / M~R 六星（最多 6 个）/ S~X 五星（最多 6 个）
 *     J 列若写「联动」→ 整行跳过（联动卡池本站不收）
 *
 * 【繁中中坚记录】B~H 列同「常驻标准寻访」的排法。其中 D~H 列写着
 *   「中坚甄选池」的行**不是**常驻中坚寻访，而是中坚甄选（干员要去【繁中中坚甄选记录】查）；
 *   写着「中坚必NEW池」的行本站不收（见下）。
 *
 * 【繁中中坚甄选记录】「第一期」~「第十二期」12 个列（D~O 列），行分 6 星块与 5 星块，
 *   单元格写 1 表示该干员在这一期里。12 期与【繁中中坚记录】里 12 个「中坚甄选池」行**按时间顺序一一对应**。
 *
 * 【Sheet5】人工算的实装/首次轮换时间差，仅供人看，脚本不读。
 *
 * ---------------------------------------------------------------- 类型判定
 *
 * 表格没写卡池类型，按「限时寻访那一行有几个六星」判定（这也是用户给的规则）：
 *   2 个 → 限定寻访（limcel / limspr / limsum，具体哪种要去国服反查）
 *   3 个 → 前路回响 mainfes          4 个 → 联合行动 joint          6 个 → 定向甄选 stdfes
 *   0 或 1 个 → 可能是「双五寻访」（`five`）或「单六寻访」（`single`）
 *
 * ⚠️ 双五寻访在表格里与单六长得一样（凝电之钻甚至也有 1 个六星），所以靠
 * **干员集合与国服那 3 个双五池完全一致**来认。
 *
 * ⚠️ 限定 / 单六 / 双五的**展示名与类型都取自国服**（表格里只有干员，没有卡池名）：
 * 用「干员名集合一致」把国服的同一个池子找出来 —— 国服有复刻池，干员集合可能与首跑相同，
 * 所以同一套干员集合的第 N 次出现，对应国服那一组里的第 N 个（按开始日排序）。
 * 例如繁中服两次「阿 + 年 + 吽」分别对上国服「地生五金」与「地生五金 复刻」。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pinyin } from 'pinyin-pro';
import { orderMeta } from './lib/meta.mjs';
import { buildNameIndex, countNameGroups, createNameMatcher, nameGroupOf } from './lib/banner-names.mjs';
import { readSheets as readAirScriptSheets, resolveConfig } from './lib/airscript.mjs';
import { makeMidBatchResolver, dryRun } from './lib/mid-batches.mjs';
import './lib/http.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'data');

const SERVER = 'tc';

/* ---- 开服锚定 ----
 * 繁中服（港澳台，龙成网络）2020-06-29 开服，开服干员集合与国服开服一致
 * （scReleaseDate 全部 = 2019-04-30，2026-10-03 数据实测 35 位，一个不差）。
 * 「首次出现」口径对这批干员是错的 —— 他们的首次出现是开服后的某次普通轮换
 * （实测错标到了 2020-07 ~ 2020-10），实装日应为繁中开服日。 */
const TC_LAUNCH_DATE = '2020-06-29';
const CN_LAUNCH_DATE = '2019-04-30';
/* 三张工作表在**云端表格里**的名字（改名后要同步这三个常量）。
   ⚠️ 数组顺序 = 金山表格的**标签页顺序**（1-based）：索引 0 → 第 1 张表、1 → 第 2 张、2 → 第 3 张。
   readSheets 按此顺序发 argv.sheet=1/2/3，脚本回传真实表名当键，名字对不上会立即告警。 */
const SHEET_ROT = '繁中轮换记录';
/* ⚠️ 「繁中中坚记录」与「繁中中坚甄选记录」两张表**2026-10-06 起不再读、不再产出中坚** ——
   常驻中坚寻访 + 中坚甄选改由**官方解包数据**提供（`scripts/fetch-gamedata.mjs` →
   `data/banners_cla_<server>.json`，站点侧合并）。人工维护的金山表在这两块上有漏写与记错
   （见 akGachaDocs/resource/官方解包数据（ArknightsGamedata）预研.md §4）。
   ⚠️ `readSheets` 是**按位置**映射的（`names[i]` → `argv.sheet = i+1`），所以只留第 1 张表就够。 */
const SHEET_NAMES = [SHEET_ROT];

/** 序号类（展示名 = 类名 + 序号，ID 名称段 = 补零 4 位） */
const SEQ_LABEL = {
  double: '常驻标准寻访',
  joint: '联合行动',
  stdfes: '定向甄选',
  mainfes: '前路回响',
};

const pad4 = (n) => String(n).padStart(4, '0');
const s = (v) => (v === null || v === undefined ? '' : String(v).trim());

// ---------------------------------------------------------------- 工具

/** 单元格文本 → YYYY-MM-DD。
 *  数据源是金山 AirScript，返回的是**显示文本**（`2020/6/29`，斜杠、不补零），
 *  走下面的字符串分支。
 *  ⚠️ 数字分支是**兜底**：万一上游哪天又变成 xlsx 序列号（旧路），也能算对，
 *  而不是静默返回 '' —— 那会让整条记录被 `if (!start) continue` 悄悄丢掉。
 *  换算以 UTC 1899-12-30 为原点：Excel 1900 系统误以为 1900 是闰年，
 *  用这个原点正好把那个错抵掉（对序列号 ≥ 1 都成立）。 */
function cellDate(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number' && v > 1000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86_400_000);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }
  const m = /(\d{4})[/-](\d{1,2})[/-](\d{1,2})/.exec(String(v));
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : '';
}

/** 干员名 → ID 名称段的拼音首字母。
 *  中文名取每个字的拼音首字母（温蒂 → wd）；非中文名（W / Mon3tr）退化为首个字母数字。 */
function pinyinInitials(name) {
  const han = s(name).replace(/[^\u4e00-\u9fa5]/g, '');
  if (han) return pinyin(han, { pattern: 'first', toneType: 'none', type: 'array' }).join('').toLowerCase();
  return s(name).replace(/[^A-Za-z0-9]/g, '').slice(0, 1).toLowerCase();
}

/** 干员名集合的键（顺序无关）—— 用来把繁中服的池子对回国服 */
const setKeyOf = (names) => [...new Set(names)].sort().join('|');

// ---------------------------------------------------------------- 读表

/**
 * 表 → `{ 表名: 二维数组 }`，直接喂给下面的 parseRotation
 * —— 它们吃的就是「表名 → 行数组」，所以**解析逻辑一行都不用改**。
 *
 * 走金山文档 AirScript webhook（不是读本地 xlsx）。云端网格由 lib 的 `normalizeGrid()`
 * 做过「去尾空行 + 每行补齐列数」，单元格一律是**显示文本**，与旧方案
 * `sheet_to_json(..., { header: 1, raw: true, defval: '' })` 的语义等价。
 */
const readSheets = (config) => readAirScriptSheets(SHEET_NAMES, config);

/** 轮换记录 → 常驻标准寻访列表 + 限时寻访列表 */
function parseRotation(rows, warnings) {
  const doubles = [];
  const limits = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const rowNo = i + 1;

    // —— 常驻标准寻访（B~H）
    const start = cellDate(r[1]);
    const six = [s(r[3]), s(r[4])].filter(Boolean);
    const five = [s(r[5]), s(r[6]), s(r[7])].filter(Boolean);
    if (start && (six.length || five.length)) {
      if (six.length !== 2 || five.length !== 3) {
        warnings.push(`[轮换 r${rowNo}] 常驻标准寻访的干员数不是 2 六星 + 3 五星：${six.length}+${five.length}`);
      }
      doubles.push({
        row: rowNo, start, end: cellDate(r[2]),
        /* 进店标记按**列**定，与干员顺序无关 */
        six: [{ name: six[0], isShop: true }, { name: six[1], isShop: false }].filter((x) => x.name),
        five: [{ name: five[0], isShop: true }, { name: five[1], isShop: false }, { name: five[2], isShop: false }]
          .filter((x) => x.name),
      });
    }

    // —— 限时寻访（K~X）
    const lstart = cellDate(r[10]);
    const lsix = r.slice(12, 18).map(s).filter(Boolean);
    const lfive = r.slice(18, 24).map(s).filter(Boolean);
    if (lstart && (lsix.length || lfive.length)) {
      limits.push({
        row: rowNo, start: lstart, end: cellDate(r[11]), tag: s(r[9]), six: lsix, five: lfive,
      });
    }
  }
  return { doubles, limits };
}

/* ---- 「常驻中坚寻访 / 中坚甄选」的解析**已整体移除**（2026-10-06）----
   原先这里有 `parseMid()`（读「繁中中坚记录」）与 `parseSelection()`（读「繁中中坚甄选记录」），
   现在这两块数据改由**官方解包数据**提供：`scripts/fetch-gamedata.mjs` → `data/banners_cla_<server>.json`。
   原因：人工维护的金山表在这两块上有漏写与记错（预研文档 §4 有实测），
   而官方解包有完整名单 + 明确的进店位。连带 `SHEET_NAMES` 也只留「繁中轮换记录」一张表了。 */

// ---------------------------------------------------------------- 国服反查

/** 国服卡池表 → 反查索引（干员集合 → 卡池）。
 *  分组规则（lim / single 只看六星、five 看全集合）统一放在 lib/banner-names.mjs，
 *  与国服 / 国际服脚本共用一份，别在这里另起一套。 */
const buildCnIndex = (cnBanners) => buildNameIndex(cnBanners);

// ---------------------------------------------------------------- 主流程

async function main() {
  const dry = process.argv.includes('--dry');

  /* 凭证（脚本令牌 / file_id / script_id）—— 缺失时 lib 会抛**带操作指引**的错误，
     因为第一次配置最容易卡在这一步（token 在哪生成、本地放哪、CI 放哪）。 */
  let config;
  try {
    config = await resolveConfig();
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }

  // —— 读国服数据（对齐干员名 / 星级 / 限定标记，并反查限定·单六·双五的卡池名）
  const cnOperators = JSON.parse(await fs.readFile(path.join(OUT_DIR, 'operators.json'), 'utf8'));
  const cnBanners = JSON.parse(await fs.readFile(path.join(OUT_DIR, 'banners_sc.json'), 'utf8'));
  const cnByName = new Map(Object.values(cnOperators).map((o) => [o.name, o]));
  const cnIndex = buildCnIndex(cnBanners);

  /* 国际服卡池表（**只读**，由 fetch-data-en.mjs 产出）：给卡池补英文名 enName。
     反查规则与国服脚本完全一致（共用 lib/banner-names.mjs），在下面第二遍里做。 */
  let enBannersRaw = null;
  try {
    enBannersRaw = JSON.parse(await fs.readFile(path.join(OUT_DIR, 'banners_en.json'), 'utf8'));
  } catch { /* 没有 banners_en.json 就全部留空 */ }

  const warnings = [];
  console.log(`· 读取金山表格（file_id ${config.fileId} / script_id ${config.scriptId}）：`);
  const sheets = await readSheets(config);
  for (const need of SHEET_NAMES) {
    if (!sheets[need] || !sheets[need].length) {
      console.error(`✗ 云端表格里读不到工作表「${need}」（或读出来是空的）`);
      process.exit(1);
    }
  }

  const { doubles, limits } = parseRotation(sheets[SHEET_ROT], warnings);
  console.log(`· 繁中轮换记录：常驻标准寻访 ${doubles.length} 条 / 限时寻访 ${limits.length} 条`);

  const banners = [];
  /** 同名同类型的序号计数器（按时间顺序发号） */
  const seqOf = {};
  /** 国服反查的已用次数：group|setKey → 已分配个数 */
  const usedCn = new Map();
  const matchedCn = [];
  const skippedCollab = [];

  const opInfo = (name, where) => {
    const op = cnByName.get(name);
    if (!op) {
      warnings.push(`${where}：干员「${name}」不在国服干员表里（联动？名字写错？）`);
      return null;
    }
    return op;
  };

  /** 把一行干员名转成 upOperators（星级来自国服干员表，避免表格里的位置写错） */
  const toUps = (list, where) => {
    const out = [];
    const seen = new Set();
    for (const item of list) {
      const { name, isShop } = typeof item === 'string' ? { name: item, isShop: false } : item;
      const op = opInfo(name, where);
      if (!op || seen.has(name)) continue;
      seen.add(name);
      out.push({ name, rarity: op.rarity, isLimited: !!op.isLimited, isShop: !!isShop });
    }
    return out;
  };
  const sortUps = (ups) => ups.slice().sort((a, b) => (b.rarity - a.rarity) || Number(a.isShop) - Number(b.isShop));

  const pushBanner = ({ type, start, end, name, upOperators, suffix, where }) => {
    const id = `${start.replace(/-/g, '')}_${type}_${suffix}`;
    banners.push({ id, name, type, startDate: start, endDate: end, upOperators: sortUps(upOperators), _where: where });
  };

  // ---- 1) 常驻标准寻访 ----
  doubles.slice().sort((a, b) => a.start.localeCompare(b.start) || a.row - b.row).forEach((d) => {
    const n = (seqOf.double = (seqOf.double || 0) + 1);
    pushBanner({
      type: 'double', start: d.start, end: d.end, suffix: pad4(n),
      name: `${SEQ_LABEL.double}${n}`, upOperators: toUps([...d.six, ...d.five], `[轮换 r${d.row}]`),
      where: `轮换 r${d.row}`,
    });
  });

  /* ---- 2) 常驻中坚寻访 与 3) 中坚甄选：**2026-10-06 起不由本脚本产出** ----
     改由官方解包数据提供（`scripts/fetch-gamedata.mjs` → `data/banners_cla_<server>.json`，
     站点侧合并）。原来的两段构造见 git 历史。 */

  // ---- 4) 限时寻访 ----
  const limitsSorted = limits.slice().sort((a, b) => a.start.localeCompare(b.start) || a.row - b.row);
  for (const L of limitsSorted) {
    const where = `轮换 r${L.row}`;
    /* J 列写「联动」的整行跳过（国服口径同样不收联动） */
    if (L.tag.includes('联动')) {
      skippedCollab.push(`${where} ${L.start} ${[...L.six, ...L.five].join('+')}`);
      continue;
    }
    const fullKey = setKeyOf([...L.six, ...L.five]);
    const sixKey = setKeyOf(L.six);
    const cnMatch = (group, key, what) => {
      const list = cnIndex[group].get(key);
      if (!list || !list.length) return null;
      const n = usedCn.get(`${group}|${key}`) || 0;
      usedCn.set(`${group}|${key}`, n + 1);
      if (n >= list.length) {
        warnings.push(`${where}：同一套${what}的第 ${n + 1} 次出现，但国服只有 ${list.length} 个对应池子，退回用最后一个`);
        return list[list.length - 1];
      }
      return list[n];
    };

    const sixN = L.six.length;
    let type = null;
    let ref = null;              // 命中的国服卡池
    let displayName = null;
    let suffix = null;
    let forcedNote = '';

    if (sixN === 2) {
      ref = cnMatch('lim', sixKey, '六星');
      if (!ref) {
        warnings.push(`${where}：${L.start} 有 2 个六星，但国服找不到同套六星的限定寻访池，已跳过`);
        continue;
      }
      type = ref.type;
      displayName = ref.name;
      suffix = L.six.map(pinyinInitials).join('');
    } else if (sixN === 3 || sixN === 4 || sixN === 6) {
      type = sixN === 3 ? 'mainfes' : sixN === 4 ? 'joint' : 'stdfes';
      const n = (seqOf[type] = (seqOf[type] || 0) + 1);
      displayName = `${SEQ_LABEL[type]}${n}`;
      suffix = pad4(n);
    } else {
      /* 0 / 1 个六星：先用「六星+五星全集合」认「双五寻访」，认不出就当单六（只按六星认） */
      const fiveRef = cnMatch('five', fullKey, '干员');
      if (fiveRef) {
        ref = fiveRef;
        type = 'five';
        displayName = fiveRef.name;
        suffix = L.five.map(pinyinInitials).join('');
        forcedNote = '（识别为双五）';
      } else {
        ref = cnMatch('single', sixKey, '六星');
        if (!ref) {
          warnings.push(`${where}：${L.start} 只有 ${sixN} 个六星，国服找不到同六星的单六寻访池，已跳过`);
          continue;
        }
        type = 'single';
        displayName = ref.name;
        suffix = L.six.map(pinyinInitials).join('');
      }
    }

    if (ref) matchedCn.push(`${where} ${L.start} [${type}] → 国服 ${ref.id}「${ref.name}」${forcedNote}`);

    const ups = toUps([
      ...L.six.map((name) => ({ name, isShop: false })),
      ...L.five.map((name) => ({ name, isShop: false })),
    ], where);
    /* 六星/五星的列位置本身就是类型信号，与干员表里的星级对不上说明抄错了 */
    for (const u of ups) {
      if (L.six.includes(u.name) && u.rarity !== 6) warnings.push(`${where}：${u.name} 填在「六星」列，但干员表里是 ${u.rarity} 星`);
      if (L.five.includes(u.name) && u.rarity !== 5) warnings.push(`${where}：${u.name} 填在「五星」列，但干员表里是 ${u.rarity} 星`);
    }
    if (!suffix) warnings.push(`${where}：名称段算不出来（干员名全非中文？），已跳过`);
    if (!suffix) continue;

    pushBanner({ type, start: L.start, end: L.end, name: displayName, suffix, upOperators: ups, where });
  }

  // ---- 去重 + 排序 ----
  const seen = new Map();
  for (const b of banners) {
    if (seen.has(b.id)) {
      warnings.push(`卡池 ID 重复（已跳过后者）: ${b.id} / ${b.name}（${b._where} 与 ${seen.get(b.id)._where}）`);
      continue;
    }
    seen.set(b.id, b);
  }
  const list = [...seen.values()].sort((a, b) =>
    a.startDate === b.startDate ? a.id.localeCompare(b.id) : a.startDate.localeCompare(b.startDate));

  /* ---- 卡池名 ----
     `name` / `scName` = 国服中文名（繁中服与国服同名，上面的反查拿到的就是它）；
     `enName` = 国际服英文名，从 banners_en.json 反查，没有的（带序号的池子三服同名）为 null。
     字段与顺序跟 banners_sc.json / banners_en.json 保持一致（`_where` 是内部调试用，不写出）。 */
  const out = {};
  for (const b of list) {
    out[b.id] = {
      name: b.name,
      scName: b.name,
      enName: null,
      type: b.type,
      startDate: b.startDate,
      endDate: b.endDate,
      upOperators: b.upOperators,
    };
  }

  /* ---- 第二遍：回填 enName ----
     ⚠️ 必须**按开始日升序**逐个查（out 就是按 list 的顺序插入的）—— 复刻池与首跑池
        干员集合相同，靠「第 N 次出现」配对；`ownCounts` 用来处理繁中服特有的「返场」池。
        国际服更慢，最新的几个池子对不上属正常。 */
  let enNameHits = 0;
  const enNameMiss = [];
  if (enBannersRaw) {
    const matcher = createNameMatcher(buildNameIndex(enBannersRaw), {
      overflow: false,
      ownCounts: countNameGroups(out),
    });
    for (const [id, b] of Object.entries(out)) {
      if (!nameGroupOf(b.type)) continue;
      const hit = matcher(b);
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

  // ---- per-干员：tcReleaseDate / tcClassicDate ----
  const firstSeen = new Map();
  for (const b of list) {
    for (const op of b.upOperators) {
      if (!firstSeen.has(op.name)) firstSeen.set(op.name, b.startDate);
    }
  }
  for (const op of Object.values(cnOperators)) {
    op.tcReleaseDate = firstSeen.get(op.name) || null;
    /* 开服干员：国服开服当天就在 roster 里 → 繁中实装日 = 繁中开服日。
       scReleaseDate 是 PRTS 权威数据且必然存在，不依赖 enReleaseDate 的准确性
       （实测盘上 enReleaseDate 曾整批滞后，见上方常量注释）。 */
    if (op.scReleaseDate && op.scReleaseDate <= CN_LAUNCH_DATE) {
      op.tcReleaseDate = TC_LAUNCH_DATE;
    }
  }

  /* ⚠️ tcClassicDate = **转入中坚寻访的日期**，按 lib/mid-batches.mjs 的批次表 + 繁中实装日判定。
     2026-10-04 改：以前是「该干员第一次出现在中坚寻访卡池」—— 那是**轮换 UP** 的日期而不是转入
     日期（实测差几个月），且没轮到就 null；繁中资料页没有这个字段，只能硬编码批次。 */
  const midOf = makeMidBatchResolver('tc');
  const midChanged = [];
  for (const op of Object.values(cnOperators)) {
    const before = op.tcClassicDate ?? null;
    op.tcClassicDate = midOf(op);
    if (before !== op.tcClassicDate) midChanged.push(`${op.name} ${before || '—'} → ${op.tcClassicDate || '—'}`);
  }

  // ---- metadata（tcGeneratedAt 要等「写盘了没有」出来才定，见下） ----
  const meta = JSON.parse(await fs.readFile(path.join(OUT_DIR, 'metadata.json'), 'utf8'));
  const dates = list.map((b) => b.startDate).sort();
  const tcEntry = (meta.servers || []).find((x) => x.id === SERVER);
  if (tcEntry) {
    tcEntry.available = true;
    tcEntry.bannerCount = list.length;
    tcEntry.earliestBanner = dates[0] || null;
    tcEntry.latestBanner = dates[dates.length - 1] || null;
  } else {
    warnings.push('metadata.servers 里没有 tc 这一项，未写入繁中服信息');
  }
  /* 数据来源页：**替换**掉旧方案留下的那条（不是追加），否则两代来源会一起留在数组里 */
  const srcNote = '金山文档·繁中卡池统计表（AirScript 云端读取）';
  const LEGACY_SRC = '繁中-卡池记录-整合版.xlsx（本地表格）';
  if (Array.isArray(meta.sourcePages)) {
    meta.sourcePages = meta.sourcePages.filter((x) => x !== LEGACY_SRC);
    if (!meta.sourcePages.includes(srcNote)) meta.sourcePages.push(srcNote);
  }

  // ---- 输出（内容一致就不写） ----
  const stab = (v) => JSON.stringify(v, null, 2) + '\n';
  const readOld = async (name) => {
    try { return await fs.readFile(path.join(OUT_DIR, name), 'utf8'); } catch { return null; }
  };
  const put = async (name, text) => {
    if (await readOld(name) === text) return false;
    if (!dry) await fs.writeFile(path.join(OUT_DIR, name), text, 'utf8');
    return true;
  };

  /* tcGeneratedAt = **banners_tc.json 的修改日**（用户口径：繁中服的数据没有抓取时间，
     就用产出文件的「最后修改日」代表这批数据是什么时候更新的）。
     ⚠️ **不能真的去 stat 文件 mtime**：CI 每次 checkout 都会把文件 mtime 重置成运行时刻，
        那样它天天是「今天」、metadata 每天产生一次空提交。
        所以用等价口径 —— **本次运行真的改写了 banners_tc.json 才推进日期**；
        没写盘（内容无变化）就沿用 metadata 里的旧值。本地手动跑时两者完全一致。 */
  const wroteBanners = await put(`banners_${SERVER}.json`, stab(out));
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const tcGeneratedAt = wroteBanners ? todayStr : (meta.tcGeneratedAt || todayStr);
  meta.tcGeneratedAt = tcGeneratedAt;

  const nextMeta = orderMeta(meta);
  const wrote = [
    wroteBanners && `banners_${SERVER}.json`,
    (await put('operators.json', stab(cnOperators))) && 'operators.json',
    (await put('metadata.json', stab(nextMeta))) && 'metadata.json',
  ].filter(Boolean);

  // ---- 报告 ----
  const byType = {};
  for (const b of list) byType[b.type] = (byType[b.type] || 0) + 1;
  const ord = ['double', 'joint', 'stdfes', 'mainfes', 'limcel', 'limspr', 'limsum', 'five', 'single'];
  console.log('');
  console.log(`✓ 繁中服卡池 ${list.length} 个`);
  console.log(`  时间范围 ${dates[0] || '—'} ~ ${dates[dates.length - 1] || '—'}`);
  console.log(`  各类型 ${ord.filter((t) => byType[t]).map((t) => `${t}×${byType[t]}`).join('  ')}`);
  console.log(`  tcGeneratedAt（数据更新日）${tcGeneratedAt}`);
  console.log(`  干员：tcReleaseDate ${[...firstSeen].length} 个 / `
    + `tcClassicDate ${Object.values(cnOperators).filter((o) => o.tcClassicDate).length} 个（批次表判定）`);
  /* 中坚批次核对（2026-10-04）：批次表里只有日期，「这段到底有哪些干员」靠这份输出确认。 */
  {
    const mid = dryRun('tc', cnOperators);
    console.log('  中坚批次（按繁中实装日切段；名单也按实装日排序，首尾一眼可核对）：');
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
  const noRel = Object.values(cnOperators).filter((o) => !o.tcReleaseDate).map((o) => o.name);
  if (noRel.length) console.log(`  繁中服尚未实装的干员（无 tcReleaseDate）${noRel.length} 位：${noRel.join('、')}`);
  if (skippedCollab.length) {
    console.log(`  跳过联动卡池 ${skippedCollab.length} 个：${skippedCollab.join('；')}`);
  }
  console.log(`  反查国服得到名称的池子 ${matchedCn.length} 个`);
  for (const m of matchedCn) console.log(`    ${m}`);
  const enNameTotal = Object.values(out).filter((b) => b.enName).length;
  console.log(`  卡池英文名：${enNameTotal} 个有 enName / ${enNameMiss.length} 个限定·单六·双五池暂时对不上国际服`
    + `${enBannersRaw ? '' : '（banners_en.json 不存在，全部留空）'}`);
  console.log(`  ${dry ? '（--dry，未写盘）' : (wrote.length ? `实际写入：${wrote.join('、')}` : '数据无变化，未写盘')}`);

  if (warnings.length) {
    console.warn(`\n⚠ 共 ${warnings.length} 条警告：`);
    for (const w of warnings.slice(0, 40)) console.warn('  - ' + w);
    if (warnings.length > 40) console.warn(`  ... 其余 ${warnings.length - 40} 条已省略`);
  }
}

main().catch((e) => {
  console.error('✗ 生成失败:', e.message);
  process.exit(1);
});
