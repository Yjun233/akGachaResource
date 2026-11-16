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
 *   · 模组名 / 密录名**各服用自己的本地化名**（`scCharName` 字段仍统一用**中文名**，
 *     因为站点是按 `operators.json` 的中文名索引的）。
 *   · ⚠️ 2026-10-12 字段改名：`char` → `scCharName`，并**新增 `charId`**
 *     （解包路径上 charId 本来就有，不需要按名字反查）。
 */
import { unixDate } from './gamedata.mjs';
import { enModuleDateOverride, EN_MODULE_LAUNCH_DATE } from './en-module-dates.mjs';

/** 无复刻窗口时的兜底窗口长度（天）—— 官方只有首发日 */
export const WINDOW_DAYS = 14;

/**
 * 「在售」判据（四个语言的「采购中心 / Store」）。
 * ⚠️ 2026-11-16 加日服 `購買部` —— 国际服的**内容源改成日服目录**后，皮肤的
 *    `obtainApproach` 是日文（`購買部` / `イベント` / `統合戦略`…），只认前三种会得 0 条。
 */
const ON_SALE_RE = /(采购中心|採購中心|Store|購買部)/;

const addDays = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** 统一的排序：先按干员名（**与 PRTS 版相同的 code-unit 比较**，别用 localeCompare），再按各自序号 */
const byCharThen = (seqKey) => (a, b) =>
  a.scCharName < b.scCharName ? -1
    : a.scCharName > b.scCharName ? 1 : (a[seqKey] ?? 0) - (b[seqKey] ?? 0);

/**
 * 模组 → `modules_<server>.json` 的 `modules[]`
 * @param {object} uniequip `uniequip_table.json`（**本服**那份：`date` / `name` / 序号都要用它）
 * @param {Record<string,string>} nameOf charId → **中文名**（三服统一）
 * @param {Set<string>} opNames 口径白名单（`operators.json` 里的干员名）
 * @param {{typeSource?: object}} [opts] `typeSource` = **国服**的 `uniequip_table.json`；
 *        给了就按 `uniEquipId` 从它取 `type`（= `typeName2`）。
 *        ⚠️ 为什么不直接用本服表：`typeName2` 是**代码**，2026-11-15 实测三服同一 id
 *        **完全一致（0 处不同）**，所以统一按国服取，口径只有一处来源。
 *        ⚠️ 但**不能连 `date` 一起用国服表**：三服推出日不同（实测 474 条日期全不同），
 *        而且 en / tw 比国服少 31 个模组 —— 站点要靠「本服推出日 ∈ 卡池窗口」判断标记。
 */
export function extractModules(uniequip, nameOf, opNames, { typeSource = null, nameSource = null, tz = 8 } = {}) {
  const dict = (uniequip && uniequip.equipDict) || {};
  const charEquip = (uniequip && uniequip.charEquip) || {};
  /* 名字的来源（国际服：`uniequip` 是**日服**表，英文名要从 **en** 表按 `uniEquipId` 取）。
     给了 `nameSource` 就意味「本服表是日服」→ 输出同时带 `jpName`。 */
  const enDict = (nameSource && nameSource.equipDict) || {};

  /* `uniEquipId → typeName2`（默认取本服表；调用方给了国服表就用国服那份） */
  const typeOf = new Map();
  for (const e of Object.values((typeSource && typeSource.equipDict) || dict)) {
    if (e && e.uniEquipId) typeOf.set(e.uniEquipId, e.typeName2 ?? null);
  }

  const out = [];
  /** 被「早期模组日期覆盖表」改掉的条数（只对 en 生效） */
  let overrides = 0;
  for (const [charId, ids] of Object.entries(charEquip)) {
    const char = nameOf[charId];
    if (!char || !opNames.has(char)) continue;
    const adv = (ids || [])
      .map((id) => dict[id])
      .filter((e) => e && e.type === 'ADVANCED' && e.uniEquipGetTime > 0)
      /* ⚠️ 自己按时间升序编号，**不用** `charEquipOrder`（见文件头说明） */
      .sort((a, b) => a.uniEquipGetTime - b.uniEquipGetTime);
    adv.forEach((e, i) => {
      const en = enDict[e.uniEquipId] || null;
      /* 日期取**两者较早**的那个：日服比国际服早 10~16 小时上线（跨天就差一天，用户 2026-11-16
         确认「早一天才是正确的」）；而极少数**真实排期不同**的（联动等，en 反而更早），
         取更早的那个才不会把上线日志写成更晚的日期。 */
      const enTime = en && en.uniEquipGetTime > 0 ? en.uniEquipGetTime : 0;
      let time = enTime > 0 && enTime < e.uniEquipGetTime ? enTime : e.uniEquipGetTime;
      /* ⚠️ 国际服早期那 43 个模组的时间戳被官方照搬成了国服的（2021-08 ~ 2022-01），
         而国际服模组功能 2022-09-16 才上线 —— 见 lib/en-module-dates.mjs 的证据链。
         `nameSource` 存在 = 正在出 en 的数据，这里直接按上线日覆盖掉。
         取当天 12:00Z 再按内容源时区换算，保证不会因为时区滑到前后一天。 */
      const ov = nameSource ? enModuleDateOverride(e.uniEquipId) : null;
      if (ov) { time = Date.parse(`${ov}T12:00:00Z`) / 1000; overrides += 1; }
      out.push({
        scCharName: char, charId, seq: i + 1,
        name: (en && en.uniEquipName) || e.uniEquipName, date: unixDate(time, tz),
        ...(nameSource ? { jpName: e.uniEquipName ?? null } : {}),
        /* 模组类型代号：X / Y / D / A / B（对照同表 `equipTypeInfos`：X、Y、D 是普通模组，
           A、B 的 `isSpecial` 为 true）。国服表取不到时退回本服。 */
        type: typeOf.get(e.uniEquipId) ?? e.typeName2 ?? null,
        /* 解包的 `uniEquipId`（`uniequip_002_mgllan` 这种）—— 落盘时**改名叫 `moduleId`**，
           避开解包那套 `uniEquip*` 前缀，跟本仓库的 `charId` / `skinIndex` 风格对齐 */
        moduleId: e.uniEquipId ?? null,
      });
    });
  }
  out.sort(byCharThen('seq'));
  if (overrides) {
    console.log(`  · 早期模组日期覆盖：${overrides} 条 → ${EN_MODULE_LAUNCH_DATE}（时间戳照搬国服）`);
  }
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
/** 把 `handbookAvgList` 按上线日聚成批次（`name` 用 `|` 分隔同一天的那几篇） */
function memoirBatches(v, tz = 8) {
  if (!Array.isArray(v && v.handbookAvgList)) return null;
  const dated = v.handbookAvgList.filter((a) => a && a.storyGetTime > 0);
  if (!dated.length) return null;
  const byDate = new Map();
  for (const a of dated) {
    const d = unixDate(a.storyGetTime, tz);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(a.storySetName);
  }
  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([date, names]) => ({ date, name: names.join('|') }));
}

export function extractMemoirs(handbook, nameOf, opNames, rarityOf = {}, { nameSource = null, tz = 8, nameTz = tz } = {}) {
  const dict = (handbook && handbook.handbookDict) || {};
  /* 名字来源（国际服：`handbook` 是**日服**表，英文名从 **en** 表按 charId 取） */
  const enDict = (nameSource && nameSource.handbookDict) || {};
  const out = [];
  for (const [charId, v] of Object.entries(dict)) {
    const char = nameOf[charId];
    if (!char || !opNames.has(char)) continue;
    /* ⚠️ 有 56 个条目的 handbookAvgList **不是数组**（实测 cn），不挡会直接崩 */
    const jp = memoirBatches(v, tz);
    if (!jp) continue;
    /* 与 en 表**按批次下标**配对（两服的批次划分一致）：
       · `name` 用英文（没有对应的就退回日文）；
       · `date` 取较早的那个（日服先上线；真实排期不同的取更早的，与模组同一口径）；
       · `jpName` 只在「本服表其实是日服」时给（即传了 `nameSource`）。 */
    const en = nameSource ? memoirBatches(enDict[charId], nameTz) : null;
    const paired = jp.map((b, i) => {
      const e = en && en[i] && en.length === jp.length ? en[i] : null;
      const date = e && e.date < b.date ? e.date : b.date;
      return {
        date,
        name: (e && e.name) || b.name,
        ...(nameSource ? { jpName: b.name } : {}),
      };
    });
    paired.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const batches = paired.map((b, i) => ({
      batch: i + 1, name: b.name, date: b.date,
      ...(b.jpName !== undefined ? { jpName: b.jpName } : {}),
    }));
    out.push({
      scCharName: char, charId, rarity: rarityOf[char] ?? null, batches,
      releaseDate: batches[0].date,
    });
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
export function extractSkins(skin, nameOf, opNames, { nameSource = null, tz = 8 } = {}) {
  const table = (skin && skin.charSkins) || {};
  /* 名字来源（国际服：`skin` 是**日服**表，英文名按 `charId#idx` 从 **en** 表取） */
  const enTable = (nameSource && nameSource.charSkins) || {};
  const byChar = new Map();
  for (const [key, s] of Object.entries(table)) {
    const d = s.displaySkin || {};
    if (!(d.getTime > 0)) continue;
    if (!ON_SALE_RE.test(d.obtainApproach || '')) continue;
    const char = nameOf[s.charId];
    if (!char || !opNames.has(char)) continue;
    if (!byChar.has(char)) byChar.set(char, { charId: s.charId || null, list: [] });
    const enDs = (enTable[key] && enTable[key].displaySkin) || null;
    /* 日期取较早的那个（日服先上线；真实排期不同的取更早的）—— 与模组同一套口径 */
    const enTime = enDs && enDs.getTime > 0 ? enDs.getTime : 0;
    const time = enTime > 0 && enTime < d.getTime ? enTime : d.getTime;
    byChar.get(char).list.push({
      name: (enDs && enDs.skinName) || d.skinName,
      jpName: nameSource ? (d.skinName ?? null) : undefined,
      time,
    });
  }
  const out = [];
  for (const [char, entry] of byChar) {
    const { charId, list } = entry;
    list.sort((a, b) => a.time - b.time);
    list.forEach((x, i) => {
      const start = unixDate(x.time, tz);
      out.push({
        scCharName: char,
        charId,
        /* 与 PRTS 版同义：该干员的第几套时装。官方没有这个字段，按首发日升序自己编号 */
        skinIndex: i + 1,
        name: x.name,
        ...(x.jpName !== undefined ? { jpName: x.jpName } : {}),
        onShelf: [
          { kind: '首发', start, end: addDays(start, WINDOW_DAYS), note: '', longTime: false },
        ],
      });
    });
  }
  out.sort(byCharThen('skinIndex'));
  return out;
}
