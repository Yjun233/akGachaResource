/**
 * 跨服「卡池名」对照 —— 三个数据脚本（国服 / 国际服 / 繁中服）共用。
 *
 * 背景：卡池的**干员名单与日期**各服独立，但**名字**来自各自的源：
 *   国服 PRTS「遗愿焰火」= 国际服 wiki.gg "Cremation Last Wish" = 繁中服「遗愿焰火」。
 *   带序号的池子（常驻标准寻访N / 常驻中坚寻访N / 中坚甄选N / 联合行动N /
 *   定向甄选N / 前路回响N）三服都叫同一个通用名，**没有英文名**。
 *   所以：需要「换名」的只有 限定寻访 / 单六寻访 / 双五寻访 这三类。
 *
 * 做法：拿**干员集合**当键，把两个服的同一批池子对起来。三个分组的键不一样
 *   （实测逼出来的，与 fetch-data-tc.mjs 原有的 `buildCnIndex` 是同一套规则）：
 *     · lim    （限定寻访 limcel/limspr/limsum）：只按**六星集合**
 *     · single （单六寻访）：只按**六星集合**
 *              ⚠️ 国际服 / 繁中服单六寻访的**第二个五星陪跑常与国服不同**
 *                 （繁中服实测 2024-06 之后的 27 个池子全是这样），
 *                 用全集合匹配会整批认不出来。
 *     · five   （双五寻访）：按**六星 + 五星全集合**
 *              ⚠️ 双五里有两个池子一个六星都没有（雾漫荒林、流沙旋涡），
 *                 只按六星认会撞在一起。
 *
 * ⚠️ 复刻池与首跑池的干员集合相同（例如「地生五金」与「地生五金 复刻」），
 *    所以按开始日排序后「第 N 次出现」对应对方那组里的第 N 个 —— 取用必须
 *    **按时间顺序**逐个调用 `createNameMatcher()` 返回的函数，别乱序。
 */

/** 卡池类型 → 反查分组；不需要跨服换名的类型返回 null */
export function nameGroupOf(type) {
  const t = String(type || '');
  if (t === 'five') return 'five';
  if (t === 'single') return 'single';
  if (t === 'limcel' || t === 'limspr' || t === 'limsum') return 'lim';
  return null;
}

/** 干员名集合的键（顺序无关） */
const setKey = (names) => [...new Set(names)].sort().join('|');

/**
 * 「返场」池：**国服 / 繁中服特有**的短期回归池（首跑后几周又开一次），
 * 国际服（wiki.gg）**不给它单独条目**。
 * 例：国服「不羁逆流」有 首跑(2020-08-11) / 返场(2020-09-08) / 复刻(2021-08-26) 三个池子，
 * 干员集合完全相同；国际服只有 首跑 / 复刻 两个。若照「第 N 次出现」硬配，
 * 国际服的复刻会被错配到国服的**返场**上，真正的复刻反而落空。
 * 所以：**建索引时跳过返场**（永不当配对目标），查询侧再按下面的「数量是否刚好对上」决定跳过。
 */
const isFlashReturn = (b) => /返场/.test(String((b && b.name) || ''));

/** 分组匹配键：lim / single 只看六星，five 看全部。
 *  ⚠️ 传进来的 `banner.upOperators` 必须是**已经定稿的** UP 名单（剔过 4★、去过重），
 *  别拿「原始解析结果」—— 名字对不上就静默匹配不到任何池子。 */
export function nameKeyOf(banner, group) {
  const ups = (banner && banner.upOperators) || [];
  if (group === 'five') {
    return setKey(ups.map((o) => o.name).filter(Boolean));
  }
  return setKey(ups.filter((o) => o.rarity === 6).map((o) => o.name).filter(Boolean));
}

/**
 * 卡池表（`id → 卡池`，即 banners_<server>.json 的内容）→ 反查索引。
 * @returns {{lim: Map<string, object[]>, five: Map<string, object[]>, single: Map<string, object[]>}}
 *          每个数组都按开始日（+ id）升序
 */
export function buildNameIndex(bannerMap) {
  const index = { lim: new Map(), five: new Map(), single: new Map() };
  const list = Object.entries(bannerMap || {})
    .map(([id, b]) => ({ id, ...b }))
    .sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)) || a.id.localeCompare(b.id));
  for (const b of list) {
    const group = nameGroupOf(b.type);
    if (!group) continue;
    if (isFlashReturn(b)) continue;        // 「返场」永不当配对目标，见上
    const key = nameKeyOf(b, group);
    if (!key) continue;
    if (!index[group].has(key)) index[group].set(key, []);
    index[group].get(key).push(b);
  }
  return index;
}

/** 卡池表 → 每个「分组|键」下**自己这边**有几个池子；`noFlash` 是排除「返场」后的数量。
 *  给 `createNameMatcher` 的 `ownCounts` 用（判断对方是不是压根没有「返场」这一类）。 */
export function countNameGroups(bannerMap) {
  const out = new Map();
  for (const b of Object.values(bannerMap || {})) {
    const group = nameGroupOf(b.type);
    if (!group) continue;
    const key = nameKeyOf(b, group);
    if (!key) continue;
    const cursor = `${group}|${key}`;
    const e = out.get(cursor) || { all: 0, noFlash: 0 };
    e.all += 1;
    if (!isFlashReturn(b)) e.noFlash += 1;
    out.set(cursor, e);
  }
  return out;
}

/**
 * 取用器：在一个索引上按调用顺序消费「同一套干员集合的第 N 次出现」。
 * 调用方**必须按开始日升序遍历自己这边需要换名的池子**。
 * @param {{overflow?: boolean, ownCounts?: Map}} [opts]
 *   opts.overflow 为 true 时，次数超出对方池子数量也不报错、退回用最后一个（繁中服的口径）；
 *   否则返回 null。
 *   opts.ownCounts 由 `countNameGroups(自己这边的卡池表)` 得到。给了它才能正确处理「返场」：
 *   只有当「自己这边排除返场后的数量」正好等于对方数量时，才认定对方没有这一条、
 *   让返场池换不到名字（并把位置让给真正的复刻）；否则照旧按顺序配。
 */
export function createNameMatcher(index, { overflow = true, ownCounts = null } = {}) {
  const used = new Map();
  return (banner) => {
    const group = nameGroupOf(banner && banner.type);
    if (!group) return null;
    const key = nameKeyOf(banner, group);
    if (!key) return null;
    const list = index[group].get(key);
    if (!list || !list.length) return null;
    const cursor = `${group}|${key}`;
    if (ownCounts && isFlashReturn(banner)) {
      const own = ownCounts.get(cursor);
      if (own && own.noFlash < own.all && own.noFlash === list.length) return null;
    }
    const n = used.get(cursor) || 0;
    used.set(cursor, n + 1);
    if (n < list.length) return list[n];
    return overflow ? list[list.length - 1] : null;
  };
}
