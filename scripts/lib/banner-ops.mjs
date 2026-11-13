/**
 * `upOperators` 的**统一排序** —— 三服（国服 / 国际服 / 繁中服）+ 中坚（官方解包）共用一个口径。
 *
 * 用户 2026-11-04 定：
 *   ① **限定寻访**（`limcel` / `limspr` / `limsum`）：限定 → 标准；
 *   ② **单六寻访 / 双五寻访**（`single` / `five`）：首发 → 其他。
 *      ⚠️ **复刻 / 返场池也按「首发时的情况」**：例如「永不落幕·复刻」里两个五星，
 *         蒂比在前、阿兰娜在后 —— 因为蒂比是「永不落幕」首发时登场的新干员。
 *   ③ **其他类型**：进店 → 陪跑，然后按实装顺序从早到晚。
 *   ④ 同一顺位内部：先按**实装日**从早到晚，同一天实装的再按 **charId 的数字**从小到大
 *      （例如同为开服 2019-04-30 实装那批，`char_002_amiya` 在 `char_123_fang` 前面）。
 *
 * ⭐ **星级是比上面三条更靠前的第一顺位（6★ 在前、5★ 在后）** —— 用户 2026-11-04 追问后确认。
 *    不然「限定 → 标准」会把当期新登场的 5★ 插进两个 6★ 中间（限定池的新 5★ 也是「标准」），
 *    而「进店 → 陪跑」也会让进店的 5★ 排到陪跑的 6★ 前面 —— 都不像卡池公告的写法。
 *    ⚠️ 站点侧所有渲染（卡池列表两列、复制文本、跨服弹窗）本来就按星级分组，
 *       所以这条只影响 JSON 自身的阅读顺序，不改任何显示。
 *
 * 📌 「首发」怎么判（2026-11-13 修正）：
 *   ① **首发池**（同系列里开始日最早的那期）：本池里实装最晚的那批 = 当期新登场的干员。
 *   ② **复刻 / 返场池**：**沿用首发池的首发组**（按 charId 认人），不再自己算「本池最晚那批」。
 *
 *   ⚠️ 原判据（所有池一律取「本池实装最晚的那批」）在繁中服翻车：用户 2026-11-13 报
 *      「未致蒙尘·复刻」的五星顺序不对 —— 该池陪跑是「寻澜」（2025-01-22 实装），
 *      比首发五星「波卜」（2024-10-09）还晚，于是寻澜被当成首发排到波卜前面。
 *      实测三服共 **7 个复刻池**都受影响（不协和音程 复刻 ×3、游邦者·复刻、沉向深渊的锚·复刻、
 *      如死亦终·复刻、未致蒙尘·复刻），原理相同：**复刻池的陪跑可能比原首发干员更新**。
 *
 *   当年不敢按名字归组，是怕「复刻池换人 + 池名三种写法」；现在三服的 `scName` 都已统一反查成
 *   国服名，去掉后缀（`\s*[·:：]?\s*(复刻|返场)$`）就能稳定配对：
 *   `未致蒙尘` / `未致蒙尘·复刻`、`不羁逆流` / `不羁逆流 返场`、`燃钢之心:暴躁铁皮` / `… 返场`。
 *   复刻池若一个首发干员都没有（整池换人）→ 交集为空 → 退回纯日期序，不会排错。
 */

/** 只有这三类按 `isLimited` 分组（实测限定干员全是六星，28 条无一例外） */
export const LIMITED_TYPES = new Set(['limcel', 'limspr', 'limsum']);

/** 只有这两类按「是不是本系列首发的新干员」分组 */
export const SERIES_TYPES = new Set(['single', 'five']);

/** 复刻 / 返场池名的后缀：`未致蒙尘·复刻`、`不羁逆流 返场` 都去掉 */
const SERIES_SUFFIX = /\s*[·:：]?\s*(复刻|返场)$/;

/** `未致蒙尘·复刻` → `未致蒙尘`（**只用于找同系列首发池**，不要拿它当展示名） */
export const seriesKeyOf = (name) => String(name ?? '').replace(SERIES_SUFFIX, '').trim();

/** `char_4247_oxi` → 4247；认不出（null / 怪格式）→ null */
export const charIdNumber = (charId) => {
  const m = /^char_(\d+)_/.exec(String(charId ?? ''));
  return m ? Number(m[1]) : null;
};

/** 比较器：数字升序，`null` 恒在最后（不要用 `?? 0` —— 那会让「未知」跑到最前） */
const byNumberAsc = (a, b) => {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  return a - b;
};

/** 日期升序，`null` 恒在最后 */
const byDateAsc = (a, b) => {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a < b ? -1 : 1;
};

/**
 * 排好一个卡池的 `upOperators`。
 *
 * @param {Array<object>} ops  `upOperators` 原数组（**不会被改动**，返回新数组）
 * @param {object} ctx
 * @param {string} ctx.type          卡池类型（11 种之一）
 * @param {(op:object)=>string|null} [ctx.releaseOf] 取该干员的**实装日**（`YYYY-MM-DD`）；
 *        三服都用**国服实装日**（`scReleaseDate`）—— 实装先后是游戏设定，三服一致，
 *        用同一个来源才能让三服同一期排出同一个顺序。
 * @param {Set<string>|string[]} [ctx.firstRunIds] 直接指定「首发组」（charId）。
 *        **复刻 / 返场池要用同系列首发池的那批人**（见 `resortSeriesBanners()`）；
 *        不传则退回「本池实装最晚的那批」——那只对**首发池**成立。
 * @returns {Array<object>} 新数组
 */
export function sortUpOperators(ops, { type, releaseOf, firstRunIds } = {}) {
  const list = Array.isArray(ops) ? ops : [];
  if (list.length < 2) return list.slice();

  const rel = new Map();
  for (const op of list) {
    let d = null;
    try {
      d = releaseOf ? releaseOf(op) || null : null;
    } catch {
      d = null; // 取不到就当未知，别让排序把整轮抓取搞挂
    }
    rel.set(op, d);
  }

  let firstRun = null;
  if (firstRunIds) {
    /* 调用方已经定好首发组（复刻池沿用首发池）—— 按 charId 认人；
       一个都对不上（整池换人）就置 null，退回纯日期序，别硬套。 */
    const ids = firstRunIds instanceof Set ? firstRunIds : new Set(firstRunIds);
    const hit = list.filter((op) => op.charId && ids.has(op.charId));
    firstRun = hit.length ? new Set(hit) : null;
  } else if (SERIES_TYPES.has(type)) {
    /* 只有「首发池」才适用：本池里实装最晚的那批 = 当期新登场的干员 */
    let latest = null;
    for (const d of rel.values()) if (d && (!latest || d > latest)) latest = d;
    firstRun = new Set(latest ? list.filter((op) => rel.get(op) === latest) : list);
  }

  /** 顺位（**只在同星级内部比**）：0 = 限定 / 首发 / 进店，1 = 标准 / 其他 / 陪跑 */
  const groupOf = (op) => {
    if (LIMITED_TYPES.has(type)) return op.isLimited ? 0 : 1;
    if (firstRun) return firstRun.has(op) ? 0 : 1;
    return op.isShop ? 0 : 1;
  };

  return list.slice().sort((a, b) => {
    /* ① 星级：6★ 在前、5★ 在后（用户 2026-11-04 确认这是第一顺位） */
    const r = (b.rarity || 0) - (a.rarity || 0);
    if (r) return r;
    /* ② 顺位：限定→标准 / 首发→其他 / 进店→陪跑 */
    const g = groupOf(a) - groupOf(b);
    if (g) return g;
    const d = byDateAsc(rel.get(a), rel.get(b));
    if (d) return d;
    const c = byNumberAsc(charIdNumber(a.charId), charIdNumber(b.charId));
    if (c) return c;
    /* 兜底：charId 都认不出（不该发生）时按名字，保证结果稳定可复现 */
    return String(a.scCharName ?? '').localeCompare(String(b.scCharName ?? ''));
  });
}

/** 某一期（**必须是首发池**）的首发组 charId —— 口径与 `sortUpOperators` 内部那条完全一致 */
function firstRunIdsOf(ops, releaseOf) {
  const list = Array.isArray(ops) ? ops : [];
  const rel = new Map();
  for (const op of list) {
    if (!op.charId) continue;
    let d = null;
    try {
      d = releaseOf ? releaseOf(op) || null : null;
    } catch {
      d = null;
    }
    rel.set(op, d);
  }
  let latest = null;
  for (const d of rel.values()) if (d && (!latest || d > latest)) latest = d;
  const out = new Set();
  if (!latest) return out;
  for (const op of list) if (op.charId && rel.get(op) === latest) out.add(op.charId);
  return out;
}

/**
 * 对**一整份 banners** 做一次「复刻池首发组归位」的重排（原地改写 `upOperators`）。
 *
 * 为什么要单独一趟：排序发生在逐池构建的那一刻，那时还看不到同系列的首发池。
 * 三服脚本都是「先按原口径排一遍 → 数据齐了再调本函数精修」，调用点在写盘之前。
 *
 * @param {object|Array<object>} banners  对象（id → banner）或数组；每项要有
 *        `{ type, startDate, upOperators, scName|name }`
 * @param {object} ctx
 * @param {(op:object)=>string|null} [ctx.releaseOf] 同 `sortUpOperators`
 * @returns {number} 实际改了顺序的池数（给日志看）
 */
export function resortSeriesBanners(banners, { releaseOf } = {}) {
  const list = Array.isArray(banners) ? banners : Object.values(banners || {});
  const groups = new Map();
  for (const b of list) {
    if (!b || !SERIES_TYPES.has(b.type)) continue;
    const key = seriesKeyOf(b.scName ?? b.name);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }

  let changed = 0;
  for (const series of groups.values()) {
    if (series.length < 2) continue;
    /* 同系列按开始日升序：第一期是首发池，复刻 / 返场必然排在它后面 */
    series.sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
    const firstRunIds = firstRunIdsOf(series[0].upOperators, releaseOf);
    if (!firstRunIds.size) continue;
    for (let i = 1; i < series.length; i += 1) {
      const b = series[i];
      const before = b.upOperators.map((o) => o.charId).join('|');
      b.upOperators = sortUpOperators(b.upOperators, { type: b.type, releaseOf, firstRunIds });
      if (b.upOperators.map((o) => o.charId).join('|') !== before) changed += 1;
    }
  }
  return changed;
}
