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
 * 📌 为什么「首发」不用「去找同系列首发池」来判：
 *   复刻池的名单**会换人**（实测 27 个复刻/返场池与首发池名单不同，比如「永不落幕·复刻」
 *   把衡沙换成了阿兰娜），而且历史上同一个系列的池名有 `·复刻` / ` 复刻` / `:暴躁铁皮` 三种写法，
 *   按名字归组会静默漏掉 21 个。所以改用一条不依赖名字、也不会看错的判据：
 *
 *   > **本池里实装最晚的那批 = 该系列首发时的新干员。**（首发池：新干员实装日 == 池开始日，
 *   > 天然是最晚的；复刻池：陪跑的都是老干员，也天然早于当初的首发干员。）
 *
 *   唯一「都算首发」的边界是**开服那批池子**（银灰色的荣耀 / 龙门特别行动专员寻访 / 火舞之人）——
 *   里面全是 2019-04-30 同一天实装的开服干员，没有新老之分，于是整池归首发组、
 *   组内自然退化成「按 charId 数字」（6★ 的 charId 恰好更小，银灰仍在最前）。
 */

/** 只有这三类按 `isLimited` 分组（实测限定干员全是六星，28 条无一例外） */
export const LIMITED_TYPES = new Set(['limcel', 'limspr', 'limsum']);

/** 只有这两类按「是不是本系列首发的新干员」分组 */
export const SERIES_TYPES = new Set(['single', 'five']);

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
 * @returns {Array<object>} 新数组
 */
export function sortUpOperators(ops, { type, releaseOf } = {}) {
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

  /* 单六 / 双五：先定出「首发组」= 本池里实装最晚的那批 */
  let firstRun = null;
  if (SERIES_TYPES.has(type)) {
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
