/**
 * metadata.json 的**规范键序** —— 三个数据脚本（国服 / 国际服 / 繁中服）共用。
 *
 * 为什么要统一：三个脚本都读改写同一个 metadata.json，比对「有没有变化」用的是
 * JSON 字符串。如果各脚本写出来的键序不同，对方就会把它们看成「改过了」，
 * 于是每次跑都产生一次空提交。所以三边都用 `orderMeta()` 过一遍再写盘。
 */

/**
 * 规范键序（其余键按原顺序追加在后面，避免丢掉将来新增的字段）
 *
 * ⚠️ **`servers[].bannerCount` 的口径 = 该服的 wiki 卡池数，不含中坚**
 * （中坚系列来自官方解包，见 `cla`）→ 站点想拿「站点上实际显示的卡池总数」，
 * 得用 `bannerCount + cla.<服>.count`（或直接数合并后的文件）。
 * 之所以保留这个「半个数」的旧名：它在数据仓库与站点**分开部署**的前提下改名/改义的
 * 兼容风险太高（线上旧站点会读到新语义）。详见
 * `akGachaDocs/resource/官方解包数据（ArknightsGamedata）预研.md`。
 */
export const META_KEYS = [
  'generatedAt',       // 国服数据生成日（= 国服「数据更新日」）
  'enGeneratedAt',     // 国际服数据生成日
  'tcGeneratedAt',     // 繁中服：表格的最后修改日
  'cla',               // 中坚系列（官方解包）的元信息 —— 由 fetch-gamedata.mjs 维护，
                       //   三个 fetch-data 脚本只负责**原样沿用**（见各脚本 meta 构造处）
  'defaultServer',
  'servers',
  'source',
  'sourcePages',
  'operatorCount',
];

/** 按规范键序重排 metadata（不改值） */
export function orderMeta(meta) {
  const out = {};
  for (const k of META_KEYS) if (k in meta) out[k] = meta[k];
  for (const k of Object.keys(meta)) if (!(k in out)) out[k] = meta[k];
  return out;
}

/** 参与「有没有变化」比对的键之外的键 —— 这几个日期本身不该触发“有变化” */
export const VOLATILE_META_KEYS = ['generatedAt', 'enGeneratedAt', 'tcGeneratedAt'];

/** 剔除易变键后的副本（用于比对） */
export function metaStable(meta) {
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    if (!VOLATILE_META_KEYS.includes(k)) out[k] = v;
  }
  return out;
}
