/**
 * lib/gamedata.mjs
 * ----------
 * **官方解包数据**（`ArknightsAssets/ArknightsGamedata`）的读取与解析 —— 目前用在
 * 「常驻中坚寻访 / 中坚甄选」上（其余卡池类型官方没有干员名单，见预研文档 §3）。
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

/** 该服的 `data_version.txt`（几十字节，用来判「解包数据有没有变」） */
export async function readDataVersion(dir, { local = null } = {}) {
  if (local) return (await fs.readFile(tablePath(local, dir, 'data_version.txt'), 'utf8')).trim();
  return (await fetchText(tableUrl(dir, 'data_version.txt'))).trim();
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
    /* ⚠️ `actType` / `actName` 是「卡池所属活动」的两个键（见 fetch-data.mjs）。中坚没有所属活动，
       恒为 null —— 但**键必须存在**，否则与其它卡池的 schema 不一致（verify-data 会查这两个键）。 */
    b.actType = null;
    b.actName = null;
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
