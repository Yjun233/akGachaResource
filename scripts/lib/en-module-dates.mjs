/**
 * lib/en-module-dates.mjs
 * ----------
 * **国际服模组「上线日」覆盖表**（2026-11-16 用户要求：写死，不去爬网站）。
 *
 * ⚠️ 解决的是什么问题：
 *   解包 `uniequip_table.json` 里，国际服早期模组的 `uniEquipGetTime` 是**照搬国服**的
 *   （日期与国服完全相同，2021-08-03 ~ 2022-01-25），但国际服的模组系统要到
 *   **2022-01-14** 才上线 —— 2021 年不可能有模组。
 *
 * 📌 日期来源：**日服官网活动公告**（`https://arknights.jp/news`），不是 wiki、也不是猜的。
 *   接口（一次拿全，`content` 全文就在列表里）：
 *     GET https://arknights.jp/api/resource/news/list?index=1&size=500&type=latest
 *   公告结构固定：`▼モジュール実装対象オペレーター` → 干员名单 → `▼実装日時` → 日期。
 *   全量 57 期，其中第一批就是：
 *     「ドッソレスホリデー」2022-01-14 16:00，★6 マゼラン / ★6 パラス / ★5 メイヤー … 8 位。
 *
 * 📌 覆盖范围怎么定的（2026-11-16 用公告逐条核对）：
 *   · 公告能给 302 条模组定到日期，其中 **277 条与解包日期完全一致** → 解包只有早期那批错；
 *   · 不一致的 25 条 = 下面 6 期（43 个）+ 诺威尔 1 条，其余一律不动；
 *   · 43 个正好是 8 / 7 / 1 / 8 / 9 / 10，与国服前 6 批**数量完全一致** —— 反过来说明
 *     「这 43 个就是被照搬的那批」这个判断没漏没多。
 *   · 诺威尔（`uniequip_002_nowell`）解包写 2025-07-17，但它是 2025-08-07 随「また明日」
 *     才实装的干员，模组不可能早于本体 —— 公告也写 2025-08-07。
 *
 * ⚠️ **不要改成「取 min(en, jp)」之类的推算**：2026-11-16 试过，会把国际服的真实日期
 *    盖成国服的日期（用户当天报的 `uniequip_002_mgllan` 就是这么错的）。
 * ⚠️ 特殊模组（`type: 'A'`，特別限定記章）**不在这张表里** —— 它们不出现在模组公告中，
 *    但解包里 jp 与 cn 的日期 0 条同日，本来就是对的，不用动。
 *
 * ⚠️ 维护：将来若又发现某条模组的日期明显早于该服的功能上线，先查日服公告，
 *    确认后把 `id: 日期` 加进来。改动后重跑 `build:gamedata --servers=en --only=extras --force`。
 */

/**
 * 模组 id（= 解包的 `uniEquipId`）→ 国际服真实上线日 `YYYY-MM-DD`。
 *
 * 按公告批次分组，注释里是对应的日服活动名（便于以后回查）。
 */
export const EN_MODULE_DATE_OVERRIDE = {
  /* 2022-01-14 「ドッソレスホリデー」—— 日服模组系统上线首批（8） */
  uniequip_002_deepcl: '2022-01-14',
  uniequip_002_doberm: '2022-01-14',
  uniequip_002_folivo: '2022-01-14',
  uniequip_002_mgllan: '2022-01-14',
  uniequip_002_otter: '2022-01-14',
  uniequip_002_pallas: '2022-01-14',
  uniequip_002_sophia: '2022-01-14',
  uniequip_002_swire: '2022-01-14',

  /* 2022-03-17 「第九章公開」（7） */
  uniequip_002_breeze: '2022-03-17',
  uniequip_002_cgbird: '2022-03-17',
  uniequip_002_cuttle: '2022-03-17',
  uniequip_002_flower: '2022-03-17',
  uniequip_002_glaze: '2022-03-17',
  uniequip_002_milu: '2022-03-17',
  uniequip_002_plosis: '2022-03-17',

  /* 2022-04-14 「赤松林」（1） */
  uniequip_002_fartth: '2022-04-14',

  /* 2022-04-28 「ニアーライト」（8） */
  uniequip_002_gravel: '2022-04-28',
  uniequip_002_kafka: '2022-04-28',
  uniequip_002_leizi: '2022-04-28',
  uniequip_002_pasngr: '2022-04-28',
  uniequip_002_phatom: '2022-04-28',
  uniequip_002_pudd: '2022-04-28',
  uniequip_002_red: '2022-04-28',
  uniequip_002_waaifu: '2022-04-28',

  /* 2022-06-30 「風雪一過」（9） */
  uniequip_002_bibeak: '2022-06-30',
  uniequip_002_bpipe: '2022-06-30',
  uniequip_002_chen: '2022-06-30',
  uniequip_002_cutter: '2022-06-30',
  uniequip_002_grani: '2022-06-30',
  uniequip_002_sddrag: '2022-06-30',
  uniequip_002_tachak: '2022-06-30',
  uniequip_002_vigna: '2022-06-30',
  uniequip_002_wildmn: '2022-06-30',

  /* 2022-07-29 「将進酒」（10） */
  uniequip_002_flameb: '2022-07-29',
  uniequip_002_franka: '2022-07-29',
  uniequip_002_gyuki: '2022-07-29',
  uniequip_002_ling: '2022-07-29',
  uniequip_002_lmlee: '2022-07-29',
  uniequip_002_nearl2: '2022-07-29',
  uniequip_002_nothin: '2022-07-29',
  uniequip_002_peacok: '2022-07-29',
  uniequip_002_skadi: '2022-07-29',
  uniequip_002_strong: '2022-07-29',

  /* 2025-08-07 「また明日」—— 解包写成 2025-07-17，但那时干员本体还没实装 */
  uniequip_002_nowell: '2025-08-07',
};

/**
 * 这个模组在国际服的真实上线日。
 * @param {string} moduleId 解包的 `uniEquipId`
 * @returns {string|null} `YYYY-MM-DD`（有覆盖时）、否则 null
 */
export const enModuleDateOverride = (moduleId) => EN_MODULE_DATE_OVERRIDE[moduleId] || null;
