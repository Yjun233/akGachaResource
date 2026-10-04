/**
 * 国际服 / 繁中服的「中坚干员转入批次」（硬编码，2026-10-04）。
 *
 * ⚠️ 为什么硬编码：wiki.gg 与繁中服资料页都**没有**「该干员何时转入中坚寻访」这个字段
 *   （国服有 —— PRTS「寻访规则」页的中坚移出批次，见 fetch-data.mjs 的 fetchClassicDates）。
 *   以前 en / tc 是拿「该干员第一次出现在中坚寻访卡池」倒推的：那是**轮换 UP** 的日期而不是
 *   转入日期（实测差 3~9 个月，如傀影国际服 2024-03-26 vs 真实 2023-10-13），没轮到更是 null。
 *
 * 判定口径（用户 2026-10-04 给的）：
 * 1. **按该服自己的实装日落段**（各服上线顺序不同，所以每服各写一份 `releaseKey`）；
 *    区间**闭**，相邻段用「上批 to = 下批 from」表示 —— 同一天实装的干员归**前一批**
 *    （`find` 先命中先返回）。
 * 2. `overrides` **先判**：国际服开放中坚时漏掉的一段、14 天后才补上。
 * 3. 限定干员（`isLimited`）→ null：中坚寻访池不含限定干员；该服尚未实装 → null。
 * 4. 落在最后一段之后 → null（国际服 = en 实装晚于 2023-03-14；第 5 批还没开放）。
 * 5. 批次日期**允许是未来**（国际服第 4 批 2026-10-09），照写。
 *
 * ⚠️ 这里**只有日期**。当初记的是「某段干员」（开服-傀影 / 温蒂-帕拉斯…），边界日期敲定后
 *   就不再记干员名了 —— 段内具体是谁由 `dryRun` 打印出来核对，别写死在这里。
 */
export const MID_BATCHES = {
  en: {
    releaseKey: 'enReleaseDate',
    /* 特例：国际服首批没放这段，14 天后补上（含两个双五寻访的五星） */
    overrides: [
      { from: '2020-09-29', to: '2020-11-26', date: '2023-10-27' },
    ],
    batches: [
      { from: null, to: '2020-12-10', date: '2023-10-13' },
      { from: '2020-12-10', to: '2021-12-29', date: '2024-11-22' },
      { from: '2021-12-29', to: '2022-06-30', date: '2025-12-05' },
      { from: '2022-06-30', to: '2023-03-14', date: '2026-10-09' },
    ],
  },
  tc: {
    releaseKey: 'tcReleaseDate',
    /* 繁中首批就全放进去了，没有特例段 */
    overrides: [],
    batches: [
      { from: null, to: '2021-05-13', date: '2024-02-13' },
      { from: '2021-05-13', to: '2022-01-11', date: '2025-02-11' },
      { from: '2022-01-11', to: '2022-09-29', date: '2025-11-18' },
    ],
  },
};

/** 干员是否落在这段区间里（闭区间；`from` 为 null 表示不设下界） */
const inSegment = (rel, seg) => (!seg.from || rel >= seg.from) && rel <= seg.to;

/**
 * 造一个「干员 → 转入中坚寻访日期」的判定函数。
 * @param {'en'|'tc'} server
 * @returns {(op: object|null) => string|null}
 */
export function makeMidBatchResolver(server) {
  const cfg = MID_BATCHES[server];
  if (!cfg) return () => null;
  return (op) => {
    if (!op || op.isLimited) return null;
    const rel = op[cfg.releaseKey];
    if (!rel) return null;                                  // 该服还没实装
    const seg = cfg.overrides.find((s) => inSegment(rel, s))
      || cfg.batches.find((s) => inSegment(rel, s));
    return seg ? seg.date : null;
  };
}

/**
 * 核对用：把判定结果按批次汇总（**不改数据**），供脚本打印给作者过目。
 *
 * ⚠️ 名单按**该服实装日**排序（不是按名字）—— 批次表本来就是按上线顺序切段的，
 *   一眼就能看出「这段的首尾干员对不对」。`outside`（还没到批次的干员）与 `limited`
 *   （按规则置 null 的限定干员）**必须分开列**，否则看不出到底漏了谁。
 * @param {'en'|'tc'} server
 * @param {object} operators charId → 干员（含 isLimited / 各服实装日）
 */
export function dryRun(server, operators) {
  const cfg = MID_BATCHES[server];
  const of = makeMidBatchResolver(server);
  const rows = Object.values(operators).map((op) => ({ op, date: of(op), rel: op[cfg.releaseKey] }));
  const segs = [
    ...cfg.overrides.map((s) => ({ ...s, kind: 'override' })),
    ...cfg.batches.map((s) => ({ ...s, kind: 'batch' })),
  ];
  const groups = segs.map((s) => {
    const hit = rows.filter((r) => r.date === s.date && r.rel && inSegment(r.rel, s))
      .sort((a, b) => (a.rel < b.rel ? -1 : 1));
    return {
      ...s,
      count: hit.length,
      first: hit[0] ? `${hit[0].op.name}(${hit[0].rel})` : '—',
      last: hit.length ? `${hit[hit.length - 1].op.name}(${hit[hit.length - 1].rel})` : '—',
      names: hit.map((r) => r.op.name),
    };
  });
  /* 段外 = 该服已实装、非限定、但没落进任何一段（还没轮到批次） */
  const outside = rows.filter((r) => r.rel && !r.date && !r.op.isLimited)
    .map((r) => r.op.name).sort();
  /* 限定干员：按规则一律 null（中坚寻访池不含它们） */
  const limited = rows.filter((r) => r.rel && r.op.isLimited)
    .map((r) => r.op.name).sort();
  return { groups, outside, limited };
}
