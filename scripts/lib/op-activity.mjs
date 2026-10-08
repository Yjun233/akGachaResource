/**
 * lib/op-activity.mjs
 * ----------
 * **干员的「实装活动」剧情线** —— 给 `operators.json` 补一个字段：
 *
 *   · `actLine`  **剧情线**名 —— 取官方解包 `stage_table.json` 的 `storylineName`
 *                （「为了明日 / 方舟 / 燎原 / 岁岁今朝 / 夏日律动 / 泰拉奇谈 …」）。
 *                拿不到对应活动时为 `null`。
 *
 * 口径、实测与全部坑见 `akGachaDocs/resource/干员实装活动剧情线预研.md`。本文件只负责实现。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ⭐ 为什么可以做「纯解包」：**「活动 → 剧情线」在解包里是完整的显式关系**，
 *    不需要 PRTS 的任何活动页：
 *
 *      stage_table.storylineStorySets[setId].relevantActivityId      // 故事集 → 活动 id
 *      stage_table.storylines[lineId].locations[].relevantStorySetId // 剧情线 → 故事集
 *      ⇒ 活动 id → 剧情线名（实测 **71/71 活动全覆盖、零缺口**，2026-10-08）
 *
 *    ⚠️ 排除 `locationType === 'BEFORE'` 的挂靠 —— 主线会把某些支线故事以「前情提要」
 *       形式挂进 mainLine 的 locations（如 生于黑夜 = `mainline_1_4_before1`）。
 *       不排除的话，生于黑夜的剧情线会变成「为了明日」。
 *
 * ⭐ 「主线章节 → 为了明日」**也可以纯解包**，但**章节开放日解包里没有**：
 *    `story_review_table.main_N.startTime` 恒为 **-1**、`zone_table` 也不带时间
 *    （第十五章起才以 `act2mainss` / `act3mainss` 这种「活动」形式有 startTime）。
 *    → 只能**把前 18 章的开放日写死在 `MAINLINE_OPEN_DATES`**（用户 2026-10-08 拍板）。
 *    ⚠️ **章节名不写死**：从 `story_review_table` 的 `main_N` 读（`main_N` 的 N 即章节顺序），
 *       这样写死的只剩 18 个日期，将来加章只补一行日期。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 归属算法（`resolveOperatorActivities`）—— **卡池 → 活动 → 剧情线**，四级：
 *
 *   ① **轮换池直接排除**（`double` / `five` / `standard` / `joint` / `classic` / `clafes`）
 *      —— 「常驻标准寻访」「五星轮换」这类池**没有所属活动**，一律 `null`。
 *      （不看这条会把开服干员全算成主线章。）
 *
 *   ② **实装日必须落在首发卡池窗口内**（`ACTIVITY_WINDOW_TOLERANCE` 天容差）。
 *      ⚠️ 这条是**筛掉「只是当期满 UP、并非该池新干员」**的关键：
 *         开服 5★ 临光实装 2019-04-30，却在 2019-05-30 的「搅动潮汐之剑」里 UP 过
 *         → 她不该拿那个池的活动。
 *
 *   ③ **精确匹配**：卡池的 `gacha_table.gachaPoolClient[].openTime` 与某个活动的
 *      `activity_table.basicInfo[].startTime` **逐秒相等**（实测大量成立）。
 *      · 命中且有剧情线 → 用它；
 *      · 命中但**全是签到 / 登录类活动**（名字匹配 `SIGN_ACTIVITY`）→ **不算数，落到 ④**；
 *      · 命中且是**非签到、但无剧情线**的活动 → **定论 `null`**（如「从星火中来」→
 *        荷谟伊智境 / 联锁竞赛、「鞘中赤红」→ 限时累计签到，都是非故事类）。
 *      ⚠️ 同一 `startTime` 可能挂多个活动（主线开放纪念页 + 登录活动）→
 *        **优先取有剧情线的**（见 `startInfo` 的构建）。
 *
 *   ④ **兜底近邻**：取「卡池开始日 ±`ACTIVITY_WINDOW_TOLERANCE` 天」内**最近**的
 *      有剧情线候选（活动 / 主线章节），同日时**非主线优先**。
 *
 *   实测（2026-10-08，对齐旧 PRTS 数据）：**230 位干员中 224 位与旧值完全一致**；
 *   仅 **6 位** 有差异，且**已按用户拍板全部采用解包新值**（不再设例外表）：
 *     · W / 极境 / 温蒂（首发「遗愿焰火」2020-05-01）：旧值 `方舟` → 新值 `为了明日`；
 *     · 泥岩 / 絮雨 / 迷迭香（首发「勿忘我」2020-11-01）：旧值 `null` → 新值 `为了明日`。
 *   ⚠️ 这 6 位都是**主线节点（第 7 / 8 章）当日实装的限定池干员** ——
 *     解包里「限定池 ↔ 主线章」没有显式关系（只有「活动 ↔ 剧情线」是显式的），
 *     它们的 `openTime` 当天在 `activity_table` 里**只对上签到类活动** → 落到 ④ 近邻主线章。
 *     旧值分别来自 PRTS「生于黑夜」活动页的「5月5日追加」段（W/极境/温蒂）与
 *     「感谢庆典 2020 / 其他」被排除（泥岩/絮雨/迷迭香），口径不统一，故改为解包统一口径。
 *
 *   另有 **2 例** `null` 干员（诗怀雅 / 陈，见 `NULL_LINE_EXCEPTIONS`）会被 ④ 误挂到
 *   主线「二次呼吸」—— 已在例外表里压掉。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ⭐ 卡池的 `rerunKind`（首发 / 复刻 / 返场）与 `canRerun`（「单六寻访会不会复刻」）
 *    **同样可以纯解包**（`rerunKindOf()` / `canRerunOf()`）：
 *
 *    解包 `gacha_table.gachaPoolClient` 里**同一池名会重复出现** ——
 *    首发一次、每次复刻再各一条，`openTime` 递增（实测 30 个池名出现 ≥2 次）。
 *    把一个池名按 `openTime` 排序后取**出现序号**与**距首发天数**：
 *      · 序号 0                     → `首发`
 *      · 序号 ≥ 1 且距首发 ≤ 180 天  → `返场`（同一活动期内的二次开放，实测 13 / 27 天）
 *      · 序号 ≥ 1 且距首发 > 180 天  → `复刻`（约一年后的正式复刻，实测最近也有 328 天）
 *    ⚠️ 解包池名**不带**「复刻 / 返场」后缀（实测 0 例），所以旧实现只能靠
 *       PRTS 池名后缀来判 —— 现在改成读这个序号 + 间隔，**PRTS 活动页请求归零、池名后缀也不再是判据**。
 *
 *    `canRerun` = 序号 0（首发）&& 最近活动（±14 天）的 storySetType === 'SS' && 不在例外表里
 *    实测 **84/84 全命中**（2026-10-08，与旧「池名后缀」实现逐条同值）。
 *    序号 ≠ 0 的池（返场 / 复刻）恒 false（已再上架过至少一次）。
 *
 *   ⚠️ 仍需那个**三元素例外表** `CAN_RERUN_EXCEPTIONS`（深夏的守夜人 / 久铸尘铁 /
 *      银灰色的荣耀）—— 这三个**首发**池的最近活动是 SS，但**实际从未复刻过**。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ⚠️ 表的体量：`stage_table.json` 26MB、`story_review_table.json` 2.4MB、`activity_table.json` 3MB、
 *    `gacha_table.json` 2MB。
 *    只在带 `--with-activities` 时读（CI 里只有周五那轮），其余轮次从旧快照回填。
 *    **本模块不碰 PRTS** —— 卡池活动页的请求量因此归零。
 */

import { loadTable } from './gamedata.mjs';

/** 「实装日期 vs 活动开始日」的容差（天）—— 见文件头 ② */
export const ACTIVITY_WINDOW_TOLERANCE = 14;

/** ⭐ 「PRTS 池名 → 解包同名池」的对齐窗口（天）—— 见 `replayIndexOf()`。
 *  PRTS 与解包的**同一次卡池开放日理应逐日相等**（实测：84/84 的 single 池在这个窗口内
 *  恰好命中同名池的那一次）。窗口给 3 天只为兜住 PRTS 侧偶发的日期补零 / 时区写法差异。 */
export const SAME_NAME_WINDOW_TOLERANCE = 3;

/** ⭐ 「返场」与「复刻」的分界（距首发天数）—— 见 `rerunKindOf()`。
 *  同一个活动期内短暂二次开放（返场）实测 13 / 27 天；约一年后的正式复刻实测最近也有 328 天。
 *  180 天离两端都很远。 */
export const SAME_POOL_REPLAY_WINDOW_DAYS = 180;

/** ⭐ 主线章节的**开放日**（解包里没有，只能写死；2026-10-08 实测 + 用户拍板）。
 *  只写日期，**章名从 `story_review_table` 的 `main_N` 读**（见文件头）。
 *  顺序 = `main_0` … `main_17`，将来加新章往数组尾部补一行即可。
 *  ⚠️ 序章 / 第一章是开服当天开放；第五章与第六章同日上线 —— 都按实测填。 */
export const MAINLINE_OPEN_DATES = Object.freeze([
  '2019-04-30', // main_0  黑暗时代·上
  '2019-04-30', // main_1  黑暗时代·下
  '2019-05-30', // main_2  异卵同生
  '2019-07-09', // main_3  二次呼吸
  '2019-10-15', // main_4  急性衰竭
  '2019-12-24', // main_5  靶向药物
  '2019-12-24', // main_6  局部坏死
  '2020-05-01', // main_7  苦难摇篮
  '2020-11-01', // main_8  怒号光明
  '2021-09-17', // main_9  风暴瞭望
  '2022-04-14', // main_10 破碎日冕
  '2022-10-11', // main_11 淬火尘霾
  '2023-04-06', // main_12 惊霆无声
  '2023-10-08', // main_13 恶兆湍流
  '2024-05-01', // main_14 慈悲灯塔
  '2025-04-07', // main_15 离解复合
  '2025-10-08', // main_16 反常光谱
  '2026-04-30', // main_17 相变临界
]);

/** ⚠️ **`canRerun` 的历史例外**（2026-10-08 定）—— 见文件头说明。
 *  这三个**首发**池的最近活动是 SS（纯算法会判 true），但**实际从未复刻过** → 强制 false。
 *  · 银灰色的荣耀（2019-05-23，紧邻 SS「骑兵与猎人」）；
 *  · 深夏的守夜人 / 久铸尘铁（紧邻 SS「火蓝之心」）。
 *  ⚠️ 例外表是「结果修正」，不是算法的一部分 —— 加新例前先确认它确实反常。 */
export const CAN_RERUN_EXCEPTIONS = Object.freeze(new Set(['深夏的守夜人', '久铸尘铁', '银灰色的荣耀']));

/** 归一化池名（与 fetch-data.mjs 的 `normName` 同一套） */
const normName = (s) => String(s || '').replace(/[^\p{L}\p{N}]/gu, '');

/** PRTS 池名的复刻 / 返场**后缀**（用于把池名还原成解包里的原名）。 */
const RERUN_SUFFIX = /[·・]?\s*(复刻|返场)$/;

/** ⚠️ **`actLine` 应为 `null` 的历史例外**（2026-10-08）——
 *  这两个干员的首发池（`鞘中赤红`，2019-07-09）恰好与主线第三章「二次呼吸」同日，
 *  但他们是**开服期的普通单池**、并非该章的干员 → ④ 兜底会误挂。
 *  ⚠️ 同样是「结果修正」：加新例前先确认它确实反常。 */
export const NULL_LINE_EXCEPTIONS = Object.freeze(new Set(['诗怀雅', '陈']));

/** 轮换池（**没有所属活动**）—— 见文件头 ①。`five` = 五星轮换池、`standard` = 常驻标准寻访。 */
const ROTATE_TYPES = new Set(['double', 'five', 'standard', 'joint', 'classic', 'clafes']);

/** 签到 / 登录类活动的名字特征 —— 见文件头 ③（命中它们时不作定论，继续近邻）。 */
const SIGN_ACTIVITY = /登录领取奖励|限时累计签到|幸运墙|矿区|开采许可|签到|公开招募/;

/** 只留字母 / 数字 / 汉字（与 fetch-data.mjs 的 normName 同一套，实测 432 个卡池名零碰撞） */
const norm = (s) => String(s || '').replace(/[^\p{L}\p{N}]/gu, '');
/** 「YYYY-MM-DD」→ 当天 00:00 (UTC+8) 的毫秒数 */
const ms = (d) => new Date(`${d}T00:00:00+08:00`).getTime();
/** Unix 秒 → 北京时间日期（`YYYY-MM-DD`） */
const unixDate = (sec) => new Date((Number(sec) + 8 * 3600) * 1000).toISOString().slice(0, 10);

/**
 * 读官方解包的四张表，产出「活动 / 主线章节 → 剧情线」的全部查询表。
 *
 * @param {string} dir   解包仓库里的目录名（cn / en / tw；本模块**只读 cn** —— 剧情线三国服一致）
 * @param {{local?: string|null}} [opts]
 * @returns {Promise<{
 *   mainlineLine: string|null,                         // 「为了明日」
 *   chapters: Array<{name:string, open:string}>,       // 主线章节（名字 + 开放日）
 *   candidates: Array<{key:string, name:string|null, line:string, open:string|null,
 *                      isSS:boolean, main:boolean}>,   // **有剧情线**的候选（供 ④ 与 canRerun）
 *   lineByNormName: Map<string,string>,                // 归一化活动名 → 剧情线（含有剧情线的活动 + 主线章）
 *   startInfo: Map<number, {line:string|null, allSign:boolean}>,   // openTime(秒) → 活动信息（供 ③）
 *   openByPoolName: Map<string, number>,               // 卡池名 → openTime(秒)（同名取最早）
 *   replayIndexByNormName: Map<string, Map<number, number>>,  // 归一化池名 → (openTime秒 → 第几次出现，从 0 起)
 * }>}
 */
export async function loadActivityTables(dir, { local = null } = {}) {
  const [stage, review, activity, gacha] = await Promise.all([
    loadTable(dir, 'stage_table.json', { local }),
    loadTable(dir, 'story_review_table.json', { local }),
    loadTable(dir, 'activity_table.json', { local }),
    loadTable(dir, 'gacha_table.json', { local }),
  ]);

  const lines = stage.storylines || {};
  const mainlineLine = lines[stage.storylineConst?.mainlineStorylineId]?.storylineName || null;
  const basic = activity.basicInfo || {};

  /* storySetId → storylineName。
     ⚠️ **排除 `locationType === 'BEFORE'` 的挂靠** —— 主线会把某些支线故事以「前情提要」
        的形式挂进 mainLine 的 locations（如 生于黑夜 = mainline_1_4_before1）。
        不排除的话，生于黑夜的剧情线会变成「为了明日」。 */
  const lineBySet = new Map();
  for (const line of Object.values(lines)) {
    for (const loc of Object.values(line.locations || {})) {
      if (!loc.relevantStorySetId || loc.locationType === 'BEFORE') continue;
      if (!lineBySet.has(loc.relevantStorySetId)) lineBySet.set(loc.relevantStorySetId, line.storylineName || null);
    }
  }

  /* 活动 id → 剧情线 + storySetType（`canRerun` 要用） */
  const lineByActivity = new Map();
  const setTypeByActivity = new Map();
  for (const [setId, s] of Object.entries(stage.storylineStorySets || {})) {
    const aid = s.relevantActivityId;
    if (!aid) continue;
    if (!setTypeByActivity.has(aid)) setTypeByActivity.set(aid, s.storySetType || null);
    const nm = lineBySet.get(setId);
    if (nm && !lineByActivity.has(aid)) lineByActivity.set(aid, nm);
  }

  /* 活动 id → 显示名（`1st*` / `act*` / `main_N` 都收） */
  const nameById = new Map();
  for (const [id, v] of Object.entries(basic)) if (v?.name) nameById.set(id, v.name);
  for (const [id, v] of Object.entries(review)) if (/^main_\d+$/.test(id) && v?.name) nameById.set(id, v.name);

  /* 活动 id → 剧情线（**复刻活动继承首发**，见文件头）。
     ⚠️ 复刻活动（如 `act11d7 火蓝之心·复刻`）**没有 storySet**，靠名字去掉尾部「复刻」找回首发。 */
  const lineByNormNameAll = new Map();
  for (const [id, line] of lineByActivity) {
    const k = norm(nameById.get(id));
    if (k && !lineByNormNameAll.has(k)) lineByNormNameAll.set(k, line);
  }
  const lineOfId = (id) => {
    const direct = lineByActivity.get(id);
    if (direct) return direct;
    const nm = nameById.get(id);
    if (!nm) return null;
    return lineByNormNameAll.get(norm(nm).replace(/复刻$/, '')) || null;
  };

  /* ---- ③ 精确表：openTime(秒) → {line, allSign} ----
     ⚠️ **同一 startTime 可能有多个活动**（主线开放纪念页 + 登录活动）→
        **优先取有剧情线的**：先设过的一律被「有剧情线」的覆盖。 */
  const startInfo = new Map();
  for (const [id, v] of Object.entries(basic)) {
    if (v?.startTime == null) continue;
    const line = lineOfId(id);
    const sign = SIGN_ACTIVITY.test(v.name || '');
    const cur = startInfo.get(v.startTime);
    if (!cur) startInfo.set(v.startTime, { line, allSign: sign });
    else {
      if (line && !cur.line) cur.line = line;
      if (!sign) cur.allSign = false;
    }
  }

  /* ---- 卡池名 → openTime（同一池名多条记录时取最早） ---- */
  const openByPoolName = new Map();
  for (const p of gacha.gachaPoolClient || []) {
    const cur = openByPoolName.get(p.gachaPoolName);
    if (cur === undefined || p.openTime < cur) openByPoolName.set(p.gachaPoolName, p.openTime);
  }

  /* ---- ⭐ 同名池的**出现序号**（`rerunKind` / `canRerun` 的判据）----
     解包里同一池名会重复出现（首发 + 每次复刻各一条，openTime 递增）。
     按 openTime 排序后，idx 0 = 首发、idx 1 = 返场、idx ≥ 2 = 复刻。
     ⚠️ 用 `norm()` 归一化后再索引，兼容 PRTS 侧的「·/:/空格」差异 —— `rerunKindOf()`
        会先把池名的「复刻 / 返场」后缀去掉再查这张表。 */
  const replayIndexByNormName = new Map();
  {
    const grouped = new Map();
    for (const p of gacha.gachaPoolClient || []) {
      const k = norm(p.gachaPoolName);
      if (!k) continue;
      if (!grouped.has(k)) grouped.set(k, []);
      grouped.get(k).push(p);
    }
    for (const [k, arr] of grouped) {
      arr.sort((a, b) => a.openTime - b.openTime);
      const m = new Map();
      arr.forEach((p, i) => m.set(p.openTime, i));
      replayIndexByNormName.set(k, m);
    }
  }

  /* ---- ④ / canRerun 用的候选（**只含有剧情线的**）---- */
  const candidates = [];
  const lineByNormName = new Map();
  for (const [id, line] of lineByActivity) {
    const name = nameById.get(id) || null;
    const start = basic[id]?.startTime ? unixDate(basic[id].startTime) : null;
    candidates.push({ key: id, name, line, open: start, isSS: setTypeByActivity.get(id) === 'SS', main: false });
    if (name) {
      const k = norm(name);
      if (k && !lineByNormName.has(k)) lineByNormName.set(k, line);
    }
  }

  /* 主线章节：名字从 `main_N` 读，开放日来自写死的表（见文件头）。
     ⚠️ **章名与日期按数组下标一一对应**（`main_N` 的 N 即章节顺序）。 */
  const chapters = [];
  for (let i = 0; i < MAINLINE_OPEN_DATES.length; i++) {
    const entry = review[`main_${i}`];
    if (!entry?.name) continue;
    const open = MAINLINE_OPEN_DATES[i];
    chapters.push({ name: entry.name, open });
    candidates.push({ key: `main_${i}`, name: entry.name, line: mainlineLine, open, isSS: false, main: true });
    const k = norm(entry.name);
    if (k && !lineByNormName.has(k)) lineByNormName.set(k, mainlineLine);
  }

  return { mainlineLine, chapters, candidates, lineByNormName, startInfo, openByPoolName, replayIndexByNormName };
}

/**
 * 给每个干员算出「实装活动剧情线」（`operators.json` 的 `actLine`）。
 *
 * @param {object} p
 * @param {Array<{name:string, scName?:string, type:string, startDate:string, endDate:string,
 *                upOperators:Array<{name:string}>}>} p.banners
 * @param {Array<{name:string, scReleaseDate:string|null}>} p.operators
 * @param {object} p.tables  `loadActivityTables()` 的返回值
 * @returns {Record<string, {actLine:string|null}>}  以**干员名**为键
 */
export function resolveOperatorActivities({ banners, operators, tables }) {
  /* 候选按开放日排序；同日时**非主线优先**（活动优先，实测更稳）。
     ⚠️ 无开放日的候选（极少数）排最后，只参与名匹配、不参与近邻。 */
  const dated = tables.candidates
    .filter((c) => c.open)
    .sort((a, b) => (ms(a.open) - ms(b.open)) || (a.main - b.main));

  /* 干员 → 最早含他的卡池（= 首发卡池） */
  const firstBanner = new Map();
  for (const b of banners) {
    for (const o of b.upOperators || []) {
      const cur = firstBanner.get(o.name);
      if (!cur || b.startDate < cur.startDate) firstBanner.set(o.name, b);
    }
  }

  const TOL = ACTIVITY_WINDOW_TOLERANCE * 86400000;

  /* ---- ④ 兜底近邻：按「日」建表，取最近的有剧情线候选 ---- */
  const byDate = new Map();
  for (const c of dated) {
    const cur = byDate.get(c.open);
    if (!cur || (cur.main && !c.main)) byDate.set(c.open, { line: c.line, main: c.main });
  }
  const nearest = (startDate) => {
    const t = ms(startDate);
    let best = null;
    for (let d = -ACTIVITY_WINDOW_TOLERANCE; d <= ACTIVITY_WINDOW_TOLERANCE; d++) {
      const day = new Date(t + d * 86400000).toISOString().slice(0, 10);
      const x = byDate.get(day);
      if (!x) continue;
      const dt = Math.abs(d);
      if (!best || dt < best.dt || (dt === best.dt && !x.main && best.main)) best = { dt, line: x.line, main: x.main };
    }
    return best ? best.line : null;
  };

  /** 单个干员 → 剧情线（四级，见文件头） */
  function lineFor(op) {
    if (NULL_LINE_EXCEPTIONS.has(op.name)) return null;
    const fb = firstBanner.get(op.name);
    if (!fb) return null;
    /* ① 轮换池：没有所属活动 */
    if (ROTATE_TYPES.has(fb.type)) return null;
    /* ② 实装日必须落在该池窗口内 —— 否则他只是「当期满 UP」，不是该池的新干员 */
    const rel = op.scReleaseDate;
    if (!rel) return null;
    const t = ms(rel);
    if (t < ms(fb.startDate) - TOL || t > ms(fb.endDate) + TOL) return null;
    /* ③ 精确匹配 openTime */
    const ot = tables.openByPoolName.get(fb.name);
    if (ot !== undefined && tables.startInfo.has(ot)) {
      const info = tables.startInfo.get(ot);
      if (info.line) return info.line;          // 命中且有剧情线 → 定论
      if (!info.allSign) return null;            // 命中且非签到但无剧情线 → 定论 null
      /* 全是签到类 → 不作数，落到 ④ */
    }
    /* ④ 兜底近邻 */
    return nearest(fb.startDate);
  }

  const out = {};
  for (const op of operators) out[op.name] = { actLine: lineFor(op) };
  return out;
}

/**
 * 卡池在解包同名池序列里的**出现序号**（0 = 首发、1 = 返场、≥2 = 复刻）。
 *
 * 判据：把 PRTS 池名的「复刻 / 返场」后缀去掉 → 归一化 → 在
 * `tables.replayIndexByNormName` 里找同名池、取 `openTime` 与 `banner.startDate`
 * （±`SAME_NAME_WINDOW_TOLERANCE` 天）最接近的那一次的序号。
 *
 * @returns {number|null}  找不到对应池时 `null`
 */
export function replayIndexOf(banner, tables) {
  const map = tables.replayIndexByNormName;
  if (!map) return null;
  const base = String(banner.name || '').replace(RERUN_SUFFIX, '');
  const byTime = map.get(normName(base));
  if (!byTime) return null;
  const t = new Date(`${banner.startDate}T00:00:00+08:00`).getTime();
  const TOL = SAME_NAME_WINDOW_TOLERANCE * 86400000;
  let best = null;
  for (const [openTime, idx] of byTime) {
    const d = Math.abs((Number(openTime) + 8 * 3600) * 1000 - t);
    if (d > TOL) continue;
    if (!best || d < best.d) best = { d, idx };
  }
  return best ? best.idx : null;
}

/**
 * 本池的开放日距**同名池首发**（序号 0）的天数 —— 供 `rerunKindOf()` 区分 返场 / 复刻。
 *
 * @returns {number|null}  找不到对应解包池时 `null`
 */
export function daysSinceFirstOf(banner, tables) {
  const map = tables.replayIndexByNormName;
  if (!map) return null;
  const base = String(banner.name || '').replace(RERUN_SUFFIX, '');
  const byTime = map.get(normName(base));
  if (!byTime || byTime.size === 0) return null;
  const first = Math.min(...byTime.keys());
  const t = new Date(`${banner.startDate}T00:00:00+08:00`).getTime();
  return Math.round((t - (Number(first) + 8 * 3600) * 1000) / 86400000);
}

/**
 * 单六寻访的 `rerunKind` —— **纯解包**（见文件头）。**只对 `single` 有意义**。
 *
 * 判据 = 解包同名池序列里的**出现序号** + **距首发的天数**：
 *   · 序号 0                    → `首发`
 *   · 序号 ≥ 1 且距首发 ≤ 180 天 → `返场`（同一个活动期内的短暂二次开放，实测仅 13 / 27 天）
 *   · 序号 ≥ 1 且距首发 > 180 天 → `复刻`（约一年后的正式复刻，实测最近的一例也有 328 天）
 * ⚠️ 两档之间实测**最小的间隔是 27 天 vs 328 天**，180 天阈值离两端都很远，非常稳。
 *
 * @param {{name:string, type:string, startDate:string, scName?:string}} banner
 * @param {object} tables  `loadActivityTables()` 的返回值
 * @returns {'首发'|'复刻'|'返场'}  非 single 或找不到对应解包池时按「首发」处理
 */
export function rerunKindOf(banner, tables) {
  if (banner.type !== 'single') return '首发';
  const idx = replayIndexOf(banner, tables);
  if (idx === null || idx === 0) return '首发';
  const gap = daysSinceFirstOf(banner, tables);
  if (gap !== null && gap <= SAME_POOL_REPLAY_WINDOW_DAYS) return '返场';
  return '复刻';
}

/**
 * 单六寻访的 `canRerun` —— **纯解包**（见文件头）。**只对 `single` 有意义**。
 *
 * @param {{name:string, type:string, startDate:string, scName?:string}} banner
 * @param {object} tables  `loadActivityTables()` 的返回值
 * @returns {boolean}  只对 `single` 可能为 true；非 single 恒 false
 */
export function canRerunOf(banner, tables) {
  if (banner.type !== 'single') return false;
  /* 序号 ≠ 0（返场 / 复刻池）已再上架过一次 → 不再有下一次（用户 2026-10-05 定）。 */
  const idx = replayIndexOf(banner, tables);
  if (idx !== null && idx !== 0) return false;
  if (CAN_RERUN_EXCEPTIONS.has(banner.name)) return false;
  /* 最近候选（±容差）是 SS（支线故事）→ 会复刻。
     ⚠️ tiebreak 必须**非主线优先**（与 `resolveOperatorActivities` 的 ④ 同向）——
        `搅动潮汐之剑`（2019-05-30）与主线第二章「异卵同生」同日，主线优先会误判成 false
        （实测该池确实复刻过 → 应为 true）。 */
  const t = ms(banner.startDate);
  const TOL = ACTIVITY_WINDOW_TOLERANCE * 86400000;
  let best = null;
  for (const c of tables.candidates) {
    if (!c.open) continue;
    const dt = Math.abs(ms(c.open) - t);
    if (dt > TOL) continue;
    if (!best || dt < best.dt || (dt === best.dt && !c.main && best.main)) best = { dt, isSS: c.isSS };
  }
  return Boolean(best?.isSS);
}
