/**
 * lib/op-activity.mjs
 * ----------
 * **干员的「实装活动」归类** —— 给 `operators.json` 补三个字段：
 *
 *   · `actType`  五选一：**主题曲 / 插曲 / 别传 / 故事集 / 其他**（无活动时为 `null`）
 *   · `actName`  该干员**首发所在活动**（PRTS 活动页标题，如「生于黑夜」「火蓝之心2020」）
 *   · `actLine`  **剧情线**名 —— 取 `stage_table.json` 的 `storylineName`
 *                （「为了明日 / 方舟 / 燎原 / 岁岁今朝 …」）。**只对上面前四类有值**，
 *                「其他」与无活动时为 `null`。
 *
 * 口径、实测与全部坑见 `akGachaDocs/resource/干员实装活动类型预研.md`。本文件只负责实现。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 数据来源（三路，按优先级合并）：
 *
 *  **路A · 首发卡池 → 活动**（主源，覆盖最广）
 *      PRTS 活动页的 `{{活动信息}}` 里有 `|限时寻访N=`，**直接列出该活动期间的卡池**
 *      → 「卡池 ↔ 活动」不用靠日期猜。干员取**最早**含他的卡池（=首发卡池，含进店位）。
 *
 *  **路B · 活动页的「信赖提升干员」**（修正源）
 *      活动页的 `{{活动信赖获取提升干员}}` = **该活动新增的干员**（实测最多 7 位，很干净）。
 *      用途：① 补 路A 抓不到的活动；② **纠正同期并存的活动** ——
 *      实测 W 的卡池「遗愿焰火」被「一周年庆典」页收录（→ 纪念活动），
 *      但他其实是「生于黑夜」的干员（路B 说得清清楚楚）。**同类并存时以路B 为准**。
 *
 *  **路C · 正文里的「干员信赖值UP」**（兜底，只对极少数主线章有用）
 *      **主线章节的活动页不写 `|限时寻访N=`**，而是把干员写在正文里
 *      （`干员信赖值UP：` + `★★★★★★：煌` 这种）。实测只有 2019 的「局部坏死」用这个写法
 *      → 收下 煌 / 灰喉 两位，其余章节没有。**别指望它覆盖多少。**
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ⚠️ 三个必须知道的口径（都是实测结论，别凭直觉改）：
 *
 *  1. **必须用「实装日期落在活动窗口内」来定夺**（`ACTIVITY_WINDOW_TOLERANCE` 天的容差）。
 *     活动是**复刻页**还是**原页**、同期有哪个庆典，全靠它区分：
 *     · 黑 实装 2019-08-27 → 落在「火蓝之心」窗口里（不是 2020 的复刻页）；
 *     · 棘刺 实装 2020-08-11 → 落在「火蓝之心2020」里（他**确实是复刻期新增的**）；
 *     · 傀影 实装 2020-04-21 → 「生于黑夜」而不是「生于黑夜2021」。
 *     容差只用来兜「活动页日期比卡池晚几天」这一种情况（实测全是 ≤7 天）。
 *     ⚠️ **没有容差就会误纳**「只是当期满 UP、并非新干员」的人（如开服 5★ 临光，
 *        实装 2019-04-30、卡池却在 2019-05-30 的「骑兵与猎人」）。
 *
 *  2. **路B 只在「同类并存」时优先**，不是无条件优先 ——
 *     若路B 的候选不在窗口内（如复刻页），照样被上面那条日期规则筛掉。
 *
 *  3. **「故事集」= 官方解包的 `MINI_ACTIVITY`**，不是 PRTS 的「微型故事」——
 *     两者其实同指，但 PRTS 的字段名容易看岔（洪炉示岁 / 午间逸话 / 乌萨斯的孩子们 …）。
 *     **「插曲」解包里没有这个区分**，只能用 PRTS 的 `关卡一览/插曲` 清单（7 个，很稳）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ⚠️ 表的体量：`stage_table.json` 26MB、`story_review_table.json` 2.4MB。
 *    所以**只在带 `--with-activities` 时读**（CI 里只有周五那轮），其余轮次从旧快照回填。
 */

import { loadTable } from './gamedata.mjs';

/** 有 `actLine` 的四个大类（其余为「其他」/null） */
export const LINE_ACT_TYPES = Object.freeze(['主题曲', '插曲', '别传', '故事集']);
/** 兜底大类 */
export const OTHER_ACT_TYPE = '其他';

/** 「实装日期 vs 活动开始日」的容差（天）—— 见文件头口径 1 */
export const ACTIVITY_WINDOW_TOLERANCE = 14;

/** PRTS 里的活动类型 → 我们的**兜底**大类（有解包时以解包为准） */
const PRTS_TYPE_HINT = { 主线: '主题曲', 微型故事: '故事集' };

/** 只留字母 / 数字 / 汉字（与 fetch-data.mjs 的 normName 同一套，实测 432 个卡池名零碰撞） */
const norm = (s) => String(s || '').replace(/[^\p{L}\p{N}]/gu, '');
/** 去掉「复刻页」的尾部 4 位年份：`生于黑夜2021` → `生于黑夜`（仅用于**查表**，不改展示名） */
const stripYear = (t) => String(t || '').replace(/\d{4}$/, '');
const dayGap = (a, b) => Math.round((new Date(a) - new Date(b)) / 86400000);

/**
 * 读官方解包的两张表，产出「活动 → 剧情线」的查询表。
 * @param {string} dir   解包仓库里的目录名（cn / en / tw）
 * @param {{local?: string|null}} [opts]
 * @returns {Promise<{mainlineLine:string|null, lineByActivity:Map<string,string>,
 *                    entryTypeByActivity:Map<string,string>, idByNormName:Map<string,string>}>}
 */
export async function loadActivityTables(dir, { local = null } = {}) {
  const [stage, review] = await Promise.all([
    loadTable(dir, 'stage_table.json', { local }),
    loadTable(dir, 'story_review_table.json', { local }),
  ]);

  const lines = stage.storylines || {};
  const mainlineLine = lines[stage.storylineConst?.mainlineStorylineId]?.storylineName || null;

  /* storySetId → storylineName。
     ⚠️ **排除 `locationType === 'BEFORE'` 的挂靠** —— 主线会把某些支线故事以「前情提要」
        的形式挂进 mainLine 的 locations 里（如 生于黑夜 = mainline_1_4_before1）。
        不排除的话，生于黑夜的剧情线会变成「为了明日」。 */
  const lineBySet = new Map();
  for (const line of Object.values(lines)) {
    for (const loc of Object.values(line.locations || {})) {
      if (!loc.relevantStorySetId || loc.locationType === 'BEFORE') continue;
      if (!lineBySet.has(loc.relevantStorySetId)) lineBySet.set(loc.relevantStorySetId, line.storylineName || null);
    }
  }

  /* storySet → relevantActivityId → storylineName；同时记下 setType 以兜「主线活动」
     （`act1mainss` 这种在 story_review 里查不到，但 setType 是 MAINLINE）。 */
  const lineByActivity = new Map();
  const setTypeByActivity = new Map();
  for (const [setId, s] of Object.entries(stage.storylineStorySets || {})) {
    const aid = s.relevantActivityId;
    if (!aid) continue;
    if (!setTypeByActivity.has(aid)) setTypeByActivity.set(aid, s.storySetType || null);
    const nm = lineBySet.get(setId);
    if (nm && !lineByActivity.has(aid)) lineByActivity.set(aid, nm);
  }

  /* 活动 id → entryType（ACTIVITY / MINI_ACTIVITY / MAINLINE）+ 名字 → id。
     ⚠️ 名字只为「PRTS 活动页标题 → 活动 id」的查表服务；复刻页去掉尾部年份再查一次。 */
  const entryTypeByActivity = new Map();
  const idByNormName = new Map();
  for (const [id, e] of Object.entries(review)) {
    if (!/^(act|1st|main_)/.test(id)) continue; // 干员密录那些 story_xxx_set_N 不要
    entryTypeByActivity.set(id, e.entryType || null);
    const k = norm(e.name);
    if (k && !idByNormName.has(k)) idByNormName.set(k, id);
  }

  return { mainlineLine, lineByActivity, entryTypeByActivity, idByNormName, setTypeByActivity };
}

/**
 * 把一个 PRTS 活动页标题归类。
 * @param {string} title   PRTS 活动页标题（如 `生于黑夜` / `火蓝之心2020`）
 * @param {string|null} prtsType 该页 `{{活动信息}}` 的 `|类型=`（兜底用）
 * @param {{tables:object, chishu:Set<string>}} ctx
 * @returns {{actType:string, actLine:string|null}}  （「其他」时 actLine 恒为 null）
 */
export function classifyActivity(title, prtsType, { tables, chishu }) {
  const base = stripYear(title);
  const id = tables.idByNormName.get(norm(base)) || tables.idByNormName.get(norm(title)) || null;
  const entryType = id ? tables.entryTypeByActivity.get(id) : null;
  const line = id ? tables.lineByActivity.get(id) : null;
  const setType = id ? tables.setTypeByActivity.get(id) : null;

  /* 主题曲：PRTS 说「主线」/ 解包说 MAINLINE / 活动挂在 MAINLINE 的 storySet 上。
     三条任一命中即可 —— 主线章节的活动页写法很不统一（有的连 限时寻访 都不写）。 */
  if (prtsType === '主线' || entryType === 'MAINLINE' || setType === 'MAINLINE') {
    return { actType: '主题曲', actLine: tables.mainlineLine };
  }
  /* 插曲：**只能用 PRTS 的清单**（解包里没有这个区分） */
  if (chishu.has(norm(base))) return { actType: '插曲', actLine: line };
  /* 故事集：解包的 MINI_ACTIVITY（= PRTS 的「微型故事」） */
  if (entryType === 'MINI_ACTIVITY' || prtsType === '微型故事') return { actType: '故事集', actLine: line };
  /* 别传：其余归档过的支线故事 */
  if (entryType === 'ACTIVITY') return { actType: '别传', actLine: line };
  /* 兜底：纪念活动 / 登录活动 / 危机合约 / 联锁竞赛 / 合作活动 / 集成战略 … */
  return { actType: OTHER_ACT_TYPE, actLine: null };
}

/**
 * 给每个干员算出「实装活动」。
 *
 * @param {object} p
 * @param {Record<string, {type:string|null, start:string|null, end:string|null,
 *                         gachas:string[], ops:string[]}>} p.activities
 *        PRTS 活动页：标题 → 解析结果（`gachas` = `|限时寻访N=` 列出的卡池名；
 *        `ops` = 该页信赖提升的干员，来源见文件头的路B/路C）
 * @param {Array<{name:string, scName?:string, startDate:string, upOperators:Array<{name:string}>}>} p.banners
 * @param {Array<{name:string, scReleaseDate:string|null}>} p.operators
 * @param {object} p.ctx  `{ tables, chishu }`（见 `classifyActivity`）
 * @returns {Record<string, {actType:string|null, actName:string|null, actLine:string|null}>}
 *          以**干员名**为键；`actName` 是**胜出的 PRTS 活动页标题**（复刻页就带年份）
 */
export function resolveOperatorActivities({ activities, banners, operators, ctx }) {
  /* ---- 路A 的桥：归一化卡池名 → 活动页标题（同一池名被首发页与复刻页都列时，取活动开始日最早的） */
  const actByBanner = new Map();
  for (const [title, a] of Object.entries(activities)) {
    for (const g of a.gachas || []) {
      const k = norm(g);
      if (!k) continue;
      const prev = actByBanner.get(k);
      if (!prev || (a.start && (!prev.start || a.start < prev.start))) actByBanner.set(k, { title, start: a.start });
    }
  }

  /* ---- 干员 → 最早含他的卡池（= 首发卡池） */
  const firstBanner = new Map();
  for (const b of banners) {
    for (const o of b.upOperators || []) {
      const cur = firstBanner.get(o.name);
      if (!cur || b.startDate < cur.startDate) firstBanner.set(o.name, b);
    }
  }

  /* ---- 路B/路C：活动页 → 它新增的干员（反向索引） */
  const actsOfOp = new Map();
  for (const [title, a] of Object.entries(activities)) {
    for (const n of a.ops || []) {
      if (!actsOfOp.has(n)) actsOfOp.set(n, []);
      if (!actsOfOp.get(n).includes(title)) actsOfOp.get(n).push(title);
    }
  }

  /** 候选打分：① 在窗口内 ② 来源含路B ③ |开始日 − 实装日| 小。
   *  ⚠️ **一个都没有「ok」就判为没有活动** —— 这正是筛掉「只是当期满 UP、并非新干员」的地方
   *     （开服 5★ 临光实装 2019-04-30，却在 2019-05-30 的「骑兵与猎人」卡池里 UP 过）。 */
  const collect = (name, rel) => {
    const cands = [];
    const add = (title, from) => {
      const a = title && activities[title];
      if (!a) return;
      const ex = cands.find((c) => c.title === title);
      if (ex) { if (!ex.from.includes(from)) ex.from += from; return; }
      const inRange = Boolean(rel && a.start && a.start <= rel && (!a.end || rel <= a.end));
      const gap = rel && a.start ? Math.abs(dayGap(rel, a.start)) : Number.POSITIVE_INFINITY;
      cands.push({ title, from, start: a.start, type: a.type, inRange, gap });
    };
    const b0 = firstBanner.get(name);
    if (b0) {
      const hit = actByBanner.get(norm(b0.name)) || actByBanner.get(norm(b0.scName));
      if (hit) add(hit.title, 'A');
    }
    for (const t of actsOfOp.get(name) || []) add(t, 'B');
    if (!cands.length) return null;
    const best = cands
      .map((c) => ({ ...c, ok: c.inRange || c.gap <= ACTIVITY_WINDOW_TOLERANCE }))
      .sort((x, y) => (y.ok - x.ok)
        || (y.inRange - x.inRange)
        || (y.from.includes('B') - x.from.includes('B'))
        || (x.gap - y.gap))[0];
    return best.ok ? best : null;
  };

  const out = {};
  for (const op of operators) {
    const best = collect(op.name, op.scReleaseDate || null);
    if (!best) {
      out[op.name] = { actType: null, actName: null, actLine: null };
      continue;
    }
    const { actType, actLine } = classifyActivity(best.title, best.type, ctx);
    out[op.name] = { actType, actName: best.title, actLine };
  }
  return out;
}
