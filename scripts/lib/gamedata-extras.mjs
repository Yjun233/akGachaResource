/**
 * lib/gamedata-extras.mjs
 * ----------
 * 官方解包数据里的 **皮肤 / 模组 / 密录** 抽取。
 *
 * ⚠️ 口径、字段语义与实测依据全在
 *    `akGachaDocs/resource/官方解包数据（ArknightsGamedata）预研.md`（§5 / §9）。本文件只实现。
 *
 * 📌 **与 PRTS 版对撞的结果**（2026-10-06，拿 `data/*.json` 逐条比）：
 *   · 模组：**按 `charEquip` 里 ADVANCED 的 `uniEquipGetTime` 升序自己编号**，
 *     与 PRTS 版 **223 位全部一致**（含「特限证章」—— 它们在官方也是 `ADVANCED`）。
 *     ⚠️ 官方的 `charEquipOrder` **不能用**：斯卡蒂的「潮湿的剑袋」order=2 但日期早于
 *     order=1 的「往日残梦」—— 它跟时间顺序无关。
 *   · 密录：**174/174 批次完全一致**（含「同一天多批合并、`name` 用 `|` 分隔」这条）。
 *     ⚠️ `handbookAvgList` 有 56 个条目**不是数组**（cn），必须 `Array.isArray` 挡一下。
 *   · 皮肤：官方**只有首发上架日**，没有复刻 / 下架窗口 → 窗口一律取
 *     `[首发日, 首发日 + 14]`（用户 2026-10-06 定；国服仍走 PRTS 的真实窗口）。
 *     且**必须剔掉非「在售」的**（活动获得 / 任务奖励 / 特典 / 集成战略…），
 *     否则会给它们造出假的「该期有皮肤在售」标记。
 *
 * ⚠️ `obtainApproach` / `uniEquipName` / `storySetName` 都是**本地化文本**：
 *   · 皮肤的在售判据必须按语言写（cn `采购中心` / tw `採購中心` / en `Store`）——
 *     拿中文去套 en/tw 会得 0 条（实测）。
 *   · 模组名 / 密录名**各服用自己的本地化名**（`char` 字段仍统一用**中文名**，
 *     因为站点是按 `operators.json` 的中文名索引的）。
 */
import { unixDate } from './gamedata.mjs';

/** 无复刻窗口时的兜底窗口长度（天）—— 官方只有首发日 */
export const WINDOW_DAYS = 14;

/** 「在售」判据（三个语言的「采购中心 / Store」） */
const ON_SALE_RE = /(采购中心|採購中心|Store)/;

const addDays = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** 统一的排序：先按干员名（**与 PRTS 版相同的 code-unit 比较**，别用 localeCompare），再按各自序号 */
const byCharThen = (seqKey) => (a, b) =>
  a.char < b.char ? -1 : a.char > b.char ? 1 : (a[seqKey] ?? 0) - (b[seqKey] ?? 0);

/**
 * 模组 → `modules_<server>.json` 的 `modules[]`
 * @param {object} uniequip `uniequip_table.json`
 * @param {Record<string,string>} nameOf charId → **中文名**（三服统一）
 * @param {Set<string>} opNames 口径白名单（`operators.json` 里的干员名）
 */
export function extractModules(uniequip, nameOf, opNames) {
  const dict = (uniequip && uniequip.equipDict) || {};
  const charEquip = (uniequip && uniequip.charEquip) || {};
  const out = [];
  for (const [charId, ids] of Object.entries(charEquip)) {
    const char = nameOf[charId];
    if (!char || !opNames.has(char)) continue;
    const adv = (ids || [])
      .map((id) => dict[id])
      .filter((e) => e && e.type === 'ADVANCED' && e.uniEquipGetTime > 0)
      /* ⚠️ 自己按时间升序编号，**不用** `charEquipOrder`（见文件头说明） */
      .sort((a, b) => a.uniEquipGetTime - b.uniEquipGetTime);
    adv.forEach((e, i) => {
      out.push({ char, seq: i + 1, name: e.uniEquipName, date: unixDate(e.uniEquipGetTime) });
    });
  }
  out.sort(byCharThen('seq'));
  return out;
}

/**
 * 密录 → `memoirs_<server>.json` 的 `memoirs[]`
 * 「同一天上线的多批合并成一条、`name` 用 `|` 分隔」与 PRTS 版口径一致。
 * @param {object} handbook `handbook_info_table.json`
 * @param {Record<string,string>} nameOf charId → 中文名
 * @param {Set<string>} opNames 口径白名单
 * @param {Record<string,number>} rarityOf 干员名 → 星级（`operators.json`；本站只收 5/6★）
 */
export function extractMemoirs(handbook, nameOf, opNames, rarityOf = {}) {
  const dict = (handbook && handbook.handbookDict) || {};
  const out = [];
  for (const [charId, v] of Object.entries(dict)) {
    const char = nameOf[charId];
    if (!char || !opNames.has(char)) continue;
    /* ⚠️ 有 56 个条目的 handbookAvgList **不是数组**（实测 cn），不挡会直接崩 */
    if (!Array.isArray(v.handbookAvgList)) continue;
    const dated = v.handbookAvgList.filter((a) => a && a.storyGetTime > 0);
    if (!dated.length) continue;
    const byDate = new Map();
    for (const a of dated) {
      const d = unixDate(a.storyGetTime);
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d).push(a.storySetName);
    }
    const batches = [...byDate.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([date, names], i) => ({ batch: i + 1, name: names.join('|'), date }));
    out.push({ char, rarity: rarityOf[char] ?? null, batches, releaseDate: batches[0].date });
  }
  out.sort((a, b) => (a.releaseDate < b.releaseDate ? -1 : a.releaseDate > b.releaseDate ? 1 : 0));
  return out;
}

/**
 * 皮肤 → `skins_<server>.json` 的 `skins[]`（**en / tw 用**；国服仍走 PRTS 的真实窗口）
 *
 * ⚠️ 官方只有一个「首发上架日」这个时间点 —— 没有复刻 / 下架窗口，所以窗口一律
 * `[首发日, 首发日 + 14]`（用户 2026-10-06 定，理由：「皮肤上架窗口可能会不按国服的来」，
 * 所以不去借国服同款皮肤的窗口长度）。
 * ⚠️ 只收**在售**的：`getTime > 0` 的皮肤里混着「活动获得 / 任务奖励 / 特典 / 集成战略」
 * 这类免费皮肤，它们对 `getTime` 是「推出时间」而不是「上架时间」，留着会造出假标记。
 */
export function extractSkins(skin, nameOf, opNames) {
  const table = (skin && skin.charSkins) || {};
  const byChar = new Map();
  for (const s of Object.values(table)) {
    const d = s.displaySkin || {};
    if (!(d.getTime > 0)) continue;
    if (!ON_SALE_RE.test(d.obtainApproach || '')) continue;
    const char = nameOf[s.charId];
    if (!char || !opNames.has(char)) continue;
    if (!byChar.has(char)) byChar.set(char, []);
    byChar.get(char).push({ name: d.skinName, start: unixDate(d.getTime) });
  }
  const out = [];
  for (const [char, list] of byChar) {
    list.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    list.forEach((x, i) => {
      out.push({
        char,
        /* 与 PRTS 版同义：该干员的第几套时装。官方没有这个字段，按首发日升序自己编号 */
        skinIndex: i + 1,
        name: x.name,
        onShelf: [
          { kind: '首发', start: x.start, end: addDays(x.start, WINDOW_DAYS), note: '', longTime: false },
        ],
      });
    });
  }
  out.sort(byCharThen('skinIndex'));
  return out;
}
