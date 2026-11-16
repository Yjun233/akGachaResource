/**
 * lib/en-module-dates.mjs
 * ----------
 * **国际服「早期模组」的日期覆盖表**（2026-11-16 用户要求：写死，不去爬网站）。
 *
 * ⚠️ 解决的是什么问题：
 *   解包 `uniequip_table.json` 里，国际服有 **43 个模组的时间戳照搬了国服**
 *   （日期与国服完全相同，2021-08-03 ~ 2022-01-25）。可国际服的模组功能要到
 *   **2022-09-16** 才上线 —— 也就是说国际服不可能在 2021 年就有模组。
 *
 * 📌 证据链（用本地解包副本按批次比出来的）：
 *   · 国服前 6 批：2021-08-03(8) / 09-17(7) / 10-15(1) / 11-01(8) / 12-21(9) / 2022-01-25(10)
 *     = 43 个，**与 en 表里的前 6 批同日期、同数量、同干员**（这就是「照搬」）。
 *   · 国际服第 7 批起：2022-09-16(12) / 2022-10-19(9) … 与国服 2022-03-15(12) / 04-14(9) …
 *     的**数量一一对应**，只是日期换成了国际服自己的。
 *   · 所以：国际服 2022-09-16 开模组功能时，国服此前那 43 个模组作为**存量**一起可用，
 *     但 en 客户端里它们的 `uniEquipGetTime` 没做本地化（照抄了国服）。
 *
 * ⚠️ 为什么不去抓网站补救：wiki.gg 没有这个数据 —— `{{Operator module}}` 模板里没有日期字段、
 *    渲染出来的干员页 HTML 里连年份都没有、`Module` 页只按分支标 `x intro = <活动名>`、
 *    没有模组相关的 Cargo 表、也没有 Update/Patch 页面。所以只能写死。
 *
 * ⚠️ 维护：出现**新的**早期漏网条目时，把 id 加进下表即可。判断依据是
 *    「en 的日期与 cn 同一天、且早于 2022-09-16」。`verify` 侧没有自动检查
 *    （`.json` 数据与解包表不在一个仓库），改动后请重跑 `build:gamedata --servers=en`。
 */

/** 国际服模组功能上线日 —— 下面这批模组在国际服的真实可获得日 */
export const EN_MODULE_LAUNCH_DATE = '2022-09-16';

/** 时间戳被照搬国服的 43 个早期模组（id = 解包的 `uniEquipId`） */
export const EN_EARLY_MODULE_IDS = [
  'uniequip_002_swire',
  'uniequip_002_folivo',
  'uniequip_002_sophia',
  'uniequip_002_mgllan',
  'uniequip_002_doberm',
  'uniequip_002_otter',
  'uniequip_002_deepcl',
  'uniequip_002_pallas',
  'uniequip_002_glaze',
  'uniequip_002_cgbird',
  'uniequip_002_breeze',
  'uniequip_002_cuttle',
  'uniequip_002_milu',
  'uniequip_002_plosis',
  'uniequip_002_flower',
  'uniequip_002_fartth',
  'uniequip_002_pasngr',
  'uniequip_002_red',
  'uniequip_002_waaifu',
  'uniequip_002_gravel',
  'uniequip_002_pudd',
  'uniequip_002_leizi',
  'uniequip_002_kafka',
  'uniequip_002_phatom',
  'uniequip_002_chen',
  'uniequip_002_tachak',
  'uniequip_002_bpipe',
  'uniequip_002_vigna',
  'uniequip_002_cutter',
  'uniequip_002_bibeak',
  'uniequip_002_grani',
  'uniequip_002_sddrag',
  'uniequip_002_wildmn',
  'uniequip_002_strong',
  'uniequip_002_peacok',
  'uniequip_002_skadi',
  'uniequip_002_lmlee',
  'uniequip_002_franka',
  'uniequip_002_gyuki',
  'uniequip_002_ling',
  'uniequip_002_nearl2',
  'uniequip_002_nothin',
  'uniequip_002_flameb',
];

const SET = new Set(EN_EARLY_MODULE_IDS);

/**
 * 这个模组的日期要不要覆盖。
 * @param {string} moduleId 解包的 `uniEquipId`
 * @returns {string|null} `YYYY-MM-DD`（要覆盖时）、否则 null
 */
export const enModuleDateOverride = (moduleId) => (SET.has(moduleId) ? EN_MODULE_LAUNCH_DATE : null);
