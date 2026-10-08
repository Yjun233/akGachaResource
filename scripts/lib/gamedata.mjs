/**
 * lib/gamedata.mjs
 * ----------
 * **官方解包数据**（`ArknightsAssets/ArknightsGamedata`）的读取与解析 —— 目前用在两处：
 *   ① 「常驻中坚寻访 / 中坚甄选」（其余卡池类型官方没有干员名单，见预研文档 §3）；
 *   ②  **异格关系**（`char_meta_table.json` 的 `spCharGroups`）→ `operators.json` 的 `alter`。
 *
 * ⚠️ 口径与实测依据全在 `akGachaDocs/resource/官方解包数据（ArknightsGamedata）预研.md`
 *    （字段语义、为什么只做中坚、进店位怎么认、以及 §9 的目标工作流）。本文件只负责实现。
 *
 * 仓库形状：master 下按服分目录 `cn / en / jp / kr / tw`，每服 `gamedata/excel/*.json`。
 *
 * ⚠️ **本机 `raw.githubusercontent.com` 会被 HTTP_PROXY 挡掉**（CONNECT tunnel 502），
 *    所以支持用环境变量 `GAMEDATA_BASE` 覆盖基础地址（实测 jsDelivr 可通）：
 *      GAMEDATA_BASE=https://cdn.jsdelivr.net/gh/ArknightsAssets/ArknightsGamedata@master
 *    **CI 上没这个代理、raw 能直连**，所以默认值就是 raw。
 *
 * ⚠️ 表很大（`character_table` 约 19MB），所以：
 *   · **生产路径**先用 `readDataVersion()` 比版本，没变就整段跳过；
 *   · **本地开发**用 `--local <解包仓库本地副本>` 直接读盘，完全不联网。
 *
 * 📌 进店位怎么认（实测 cn 75/75、tw 54/54 成立）：
 *    `CLASSIC` / `CLASSIC_DOUBLE` 的 `dynMeta`：
 *      `main6RarityCharId` = **进店六星**，`sub6RarityCharId` = 陪跑六星，
 *      `rare5CharList[0]`  = **进店五星**，`rare5CharList[1..2]` = 陪跑五星。
 *    ⚠️ 我们 `banners_<server>.json` 里 `upOperators` 的**既有排序**是
 *       `[陪跑6★, 进店6★, 陪跑5★…, 进店5★]`（把官方的 index0 挪到最后），
 *       这里**照抄那个顺序**，免得无谓地改动站点显示与逐格对比。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const REPO = 'ArknightsAssets/ArknightsGamedata';
const REF = 'master';

/** 我们这边（站点/资源仓库）的服务器 id ↔ 解包仓库的目录名 */
export const SERVER_DIR = { sc: 'cn', en: 'en', tc: 'tw' };

/** 中坚系列的两个 type → 展示名（与站点 `constants.js` 的 TYPE_LABEL 一致，但别跨仓 import） */
export const MID_LABEL = { classic: '常驻中坚寻访', clafes: '中坚甄选' };

const baseUrl = () =>
  (process.env.GAMEDATA_BASE || `https://raw.githubusercontent.com/${REPO}/${REF}`).replace(/\/+$/, '');

const tableUrl = (dir, table) => `${baseUrl()}/${dir}/gamedata/excel/${table}`;
const tablePath = (local, dir, table) => path.join(local, dir, 'gamedata', 'excel', table);

/** 带退避重试的文本抓取（jsDelivr 偶发 404、raw 偶发限流，重试一次就好） */
export async function fetchText(url, tries = 4) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (res.ok) return await res.text();
      last = new Error(`HTTP ${res.status}`);
    } catch (e) {
      last = e;
    }
    if (i < tries) await new Promise((r) => setTimeout(r, 700 * i));
  }
  throw new Error(`拉取失败 ${url}：${last && last.message}`);
}

/**
 * 读一个 excel 表。
 * @param {string} dir   解包仓库里的目录名（cn / en / tw）
 * @param {string} table 表文件名（带 .json）
 * @param {{local?: string|null}} [opts] `local` = 本地副本根目录，给了就不联网
 */
export async function loadTable(dir, table, { local = null } = {}) {
  if (local) return JSON.parse(await fs.readFile(tablePath(local, dir, table), 'utf8'));
  return JSON.parse(await fetchText(tableUrl(dir, table)));
}

/**
 * 该服的 `data_version.txt`（几十字节，用来判「解包数据有没有变」）。
 * ⚠️ 原文件是 **CRLF** 结尾 —— 必须归一成 LF 再入库，否则换行符会**原样写进**
 *    `banners_cla_*.json` 的 `dataVersion` 字符串里（值变成 `…rel77.0\r\nChange:…`），
 *    既污染 JSON 又与全仓库 LF 约定冲突。
 */
export async function readDataVersion(dir, { local = null } = {}) {
  const raw = local
    ? await fs.readFile(tablePath(local, dir, 'data_version.txt'), 'utf8')
    : await fetchText(tableUrl(dir, 'data_version.txt'));
  return raw.replace(/\r\n?/g, '\n').trim();
}

/**
 * charId → 该服**本地化名**。
 * ⚠️ 对撞 / 输出时**不要**用别的服的名字：我们三服的 `upOperators[].name` 统一是**简体中文名**，
 *    所以真正做匹配时要拿 **cn** 的名字表（见 `bannersOf()` 的 `nameOf` 参数）。
 */
export async function loadNames(dir, { local = null } = {}) {
  const tbl = await loadTable(dir, 'character_table.json', { local });
  const out = {};
  for (const [id, v] of Object.entries(tbl)) if (v && v.name) out[id] = v.name;
  return out;
}

/**
 * charId → **阵营**（写进 `operators.json` 的 `group` / `subGroup`，2026-10-07 加）。
 *
 * 来源 = `character_table.json` 的三个字段（**原始内部 id**，不是本地化名）：
 *   · `nationId` → `group`（**国家 / 地区**，如 `lungmen` 龙门 / `rhodes` 罗德岛 / `kazimierz` 卡西米尔）
 *   · `groupId` **或** `teamId` → `subGroup`（**组织 / 小队**，如 `penguin` 企鹅物流 / `lgd` 龙门近卫局）
 *
 * ⚠️ 实测口径（2026-10-07，cn 表 1375 条 / 本项目 230 位在册干员）：
 *   · **`groupId` 与 `teamId` 互斥** —— 全表 0 例同时有值（用户也是这么说的）。
 *     取 `groupId ?? teamId` 即可，**不要**拼起来。
 *   · **三服取值完全一致**（cn / en / tw 同名 charId 的三个字段逐位相同）→ **读 cn 一份就够**，
 *     不像名字那样要分服。（en / tw 表里没有的新干员，是「该服还没上」而不是值不同。）
 *   · **覆盖率不是 100%**：230 位里 `nationId` 有 **223**（7 位为 `null`）、
 *     `groupId|teamId` 有 **74**（156 位为 `null`）—— 空值是**正常**的，别当成抓漏。
 *
 * @returns {Promise<Map<string, {nationId:string|null, groupId:string|null, teamId:string|null}>>}
 */
export async function loadAffiliations(dir, { local = null } = {}) {
  const tbl = await loadTable(dir, 'character_table.json', { local });
  const out = new Map();
  for (const [id, v] of Object.entries(tbl)) {
    if (!v) continue;
    out.set(id, {
      nationId: v.nationId || null,
      groupId: v.groupId || null,
      teamId: v.teamId || null,
    });
  }
  return out;
}

/**
 * 读 `char_meta_table.json` 的 **`spCharGroups`（异格分组）**。
 *
 * 形状：`{ 本体charId: [本体charId, 异格charId, …] }` —— 键是**本体**，值是整组。
 * ⚠️ **绝大多数组只有一个元素**（没有同族的干员也各占一条）：
 *    实测 cn **420 组**里只有 **37 组**是多成员（合共 **38 个**异格 charId）。
 */
export async function loadSpCharGroups(dir, { local = null } = {}) {
  const tbl = await loadTable(dir, 'char_meta_table.json', { local });
  return tbl?.spCharGroups || {};
}

/**
 * 由异格分组 + 「在册干员」集合，算出 `charId → [同组的其它 charId…]`
 * （写进 `operators.json` 每个干员条目的 `alter` 字段）。
 *
 * 口径（用户 2026-10-06 定）：**组内「在册」的成员两两互填** ——
 *   · 本体填异格、**异格也填本体**；
 *   · 一组有 3 个成员（如「陈」+「假日威龙陈」+「赤刃明霄陈」）时，
 *     **每个成员都填另外两个**。
 *
 * 只在册的成员参与 —— **不在册的成员一律不出现**（用户：「charId 没在 `operators.json`
 * 存储的干员则不存入」）。所以：
 *   · 本体不在册（实测 **13 组**本体是 3~4★）→ 该组的异格**填不到别人**，`alter` 为空
 *     （如「承曦格雷伊」的本体格雷伊是 4★；其余 6 组的异格本就是 5~6★，但同样只剩自己一个）；
 *   · 异格不在册 → 它不出现在任何人的 `alter` 里（实测 1 例：「淬羽赫默」没进过寻访）。
 *   · 结论：**只有「在册成员 ≥ 2」的组才会产生非空 `alter`**。
 *
 * → 实测结果：**47 位**干员有非空 `alter`，合共 **50 个** charId
 *   （22 组两人互填 = 44，加上「陈」那组三人各填两个 = 6）。
 *
 * @param {Record<string, string[]>} spCharGroups `loadSpCharGroups()` 的返回值
 * @param {Set<string>} validIds 在册 charId 集合（= `operators.json` 的键）
 * @returns {Map<string, string[]>} 只有**非空**的才在表里；其余干员由调用方给 `[]`
 */
export function buildAlterMap(spCharGroups, validIds) {
  const out = new Map();
  for (const [base, ids] of Object.entries(spCharGroups || {})) {
    /* 组内去重后**只留「在册」的**；不足 2 个就没有可互填的对象 */
    const group = [...new Set([base, ...(ids || [])])].filter((id) => validIds.has(id));
    if (group.length < 2) continue;
    for (const id of group) out.set(id, group.filter((x) => x !== id));
  }
  return out;
}

/** Unix 秒 → 北京时间日期（`YYYY-MM-DD`）。官方 openTime/endTime 都是**秒** */
export const unixDate = (sec) => new Date((Number(sec) + 8 * 3600) * 1000).toISOString().slice(0, 10);

function makeOp(name, rarity, isShop) {
  return { name, rarity, isLimited: false, isShop: Boolean(isShop) };
}

/**
 * 从一个服的 `gacha_table.json` 里抽出**中坚系列**卡池。
 *
 * @param {object} gacha        `gacha_table.json` 的解析结果
 * @param {Record<string,string>} nameOf charId → 名字（**三服统一用 cn 的名字表**）
 * @returns {{classic: object[], clafes: object[]}} 已按开始日升序、并且**已编好 id / name**
 */
export function extractMid(gacha, nameOf) {
  const pools = (gacha && gacha.gachaPoolClient) || [];
  const named = (id) => nameOf[id] || null;

  /* ---- 常驻中坚寻访：CLASSIC + CLASSIC_DOUBLE（同一个东西，2025-03 换代，见预研 §3） ---- */
  const classic = pools
    .filter(
      (p) =>
        (p.gachaRuleType === 'CLASSIC' || p.gachaRuleType === 'CLASSIC_DOUBLE') &&
        p.dynMeta &&
        p.dynMeta.main6RarityCharId
    )
    .sort((a, b) => a.openTime - b.openTime)
    .map((p) => {
      const m = p.dynMeta;
      const r5 = (m.rare5CharList || []).map(named);
      const ups = [
        makeOp(named(m.sub6RarityCharId), 6, false),        // 陪跑六星
        makeOp(named(m.main6RarityCharId), 6, true),        // 进店六星
        ...r5.slice(1).map((n) => makeOp(n, 5, false)),     // 陪跑五星
        r5[0] ? makeOp(r5[0], 5, true) : null,              // 进店五星（官方 index0）
      ].filter((o) => o.name);
      return { type: 'classic', startDate: unixDate(p.openTime), endDate: unixDate(p.endTime), upOperators: ups };
    });

  /* ---- 中坚甄选：FESCLASSIC，`rarityPickCharDict` 是**候选池**（玩家自选），口径与我们现有数据一致 ---- */
  const clafes = pools
    .filter((p) => p.gachaRuleType === 'FESCLASSIC' && p.dynMeta && p.dynMeta.rarityPickCharDict)
    .sort((a, b) => a.openTime - b.openTime)
    .map((p) => {
      const d = p.dynMeta.rarityPickCharDict;
      const ups = [
        ...(d.TIER_6 || []).map((c) => makeOp(named(c), 6, false)),
        ...(d.TIER_5 || []).map((c) => makeOp(named(c), 5, false)),
      ].filter((o) => o.name);
      return { type: 'clafes', startDate: unixDate(p.openTime), endDate: unixDate(p.endTime), upOperators: ups };
    });

  assignIds(classic);
  assignIds(clafes);
  return { classic, clafes };
}

/**
 * 给同一 type 的卡池按**开始日升序**编序号，并生成 `name` / `scName` / `id`。
 * 口径与现有数据完全一致：`name = <展示名><序号>`，`id = YYYYMMDD_<type>_<4 位序号>`。
 * ⚠️ 现有三服的中坚系列名字**正好就是**「常驻中坚寻访1..N」「中坚甄选1..N」（实测），
 *    所以这里重新编号不会改名。
 */
export function assignIds(list) {
  list.forEach((b, i) => {
    const n = i + 1;
    b.name = `${MID_LABEL[b.type]}${n}`;
    b.scName = b.name;
    b.enName = null;
    b.id = `${b.startDate.replace(/-/g, '')}_${b.type}_${String(n).padStart(4, '0')}`;
  });
  return list;
}

/** 把 `{classic: [], clafes: []}` 摊平成 `id → banner` 的字典（= `banners_<server>.json` 的形状） */
export function toBannerMap({ classic, clafes }) {
  const out = {};
  for (const b of [...classic, ...clafes]) {
    const { id, ...rest } = b;
    out[id] = rest;
  }
  return out;
}

/** 中坚系列的类型集合（给「PRTS 那几个脚本要跳过哪些卡池」用） */
export const MID_TYPES = ['classic', 'clafes'];
