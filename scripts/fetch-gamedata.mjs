/**
 * fetch-gamedata.mjs
 * 从**官方解包数据**（`ArknightsAssets/ArknightsGamedata`）抽取数据。做两块：
 *
 *   ① **中坚系列**：常驻中坚寻访（`CLASSIC` / `CLASSIC_DOUBLE`）+ 中坚甄选（`FESCLASSIC`）。
 *      其余卡池类型官方**没有干员名单**（单六寻访 35 条全无、常驻标准 233 条仅 10 条有文案…），
 *      仍由 PRTS / wiki.gg / 金山 那几个脚本负责 —— 见预研文档 §3。
 *   ② **extras**：模组 / 密录 / 皮肤，只收 `operators.json` 里那 230 位（= 参与过寻访 UP 的干员）。
 *      ⚠️ **国服皮肤不走这条线** —— 它由 `fetch-skins.mjs` 从 PRTS 抓（那里有真实的复刻 / 下架窗口）。
 *      官方只有「首发上架日」这一个点，所以只给 en / tw 出，窗口按 `WINDOW_DAYS` 天兜底。
 *
 * 输出：
 *   data/banners_cla_<server>.json   常驻中坚寻访 + 中坚甄选（**单独一个文件**，不与
 *                                    `banners_<server>.json` 混写；站点侧合并）
 *   data/modules_<server>.json       干员模组（三服）
 *   data/memoirs_<server>.json       干员密录（三服）
 *   data/skins_<server>.json         干员皮肤（**只有 en / tw**；国服由 fetch-skins.mjs 出）
 *   data/metadata.json 的 `cla` 键     中坚元信息的**镜像**：`{ source, sc|en|tc: { generatedAt, count } }`
 *                                    —— 站点左栏「中坚数据更新」读它。内容一致就不写盘。
 *                                    ⚠️ 三个 fetch-data 脚本构造 metadata 时是**全新对象**，
 *                                    所以它们各自把 `cla` 原样沿用（不然会被抹掉）。
 *
 * 口径的**权威说明**在 `akGachaDocs/resource/官方解包数据（ArknightsGamedata）预研.md`
 * （实测数字、字段语义、目标工作流 §9）。本文件只实现，不再重复论证。
 *
 * 用法：
 *   node scripts/fetch-gamedata.mjs --check            只对撞、不落盘
 *       中坚的对撞对象 = **站点实际用的那一套**（`banners_<srv>.json` 合并 `banners_cla_<srv>.json`）；
 *       extras 的对撞对象 = 已落盘的 `modules_/memoirs_/skins_<srv>.json`。
 *       正常都应是 0 差异。⚠️ 接入前（2026-10-06 之前）它比的是 **wiki 抓到的中坚** ——
 *       那轮实测结果留档在 `akGachaDocs/resource/官方解包数据（ArknightsGamedata）预研.md` §4。
 *   node scripts/fetch-gamedata.mjs --check --dump     对撞 + 打印抽出来的中坚 JSON
 *   node scripts/fetch-gamedata.mjs                    抽取并写盘（内容没变则不写）
 *
 * 常用选项：
 *   --servers sc,en,tc   只处理指定服务器（默认三服）
 *   --only mid|extras    只做其中一块（默认 all = 两块都做）
 *   --local <dir>        从本地解包仓库副本读**全部**表（完全不联网）
 *   --local-names <dir>  只把 `character_table.json` 走本地、其余走网络
 *                        （本地开发的常用姿势：jsDelivr **供不了 21MB 的 character_table**，见下）
 *   --force              忽略「内容没变不写盘」，强制写
 *
 * ⚠️ **`raw.githubusercontent.com` 在本机被 HTTP_PROXY 挡掉**（CONNECT tunnel 502），
 *    **jsDelivr 可以当镜像但只到 20MB**：`character_table.json`（cn 21.6MB / en 19.8MB）
 *    会**直接 403**（实测），其余表都正常。而 `raw.githack.com` / `cdn.statically.io` 本机被代理挡、
 *    `gcore.jsdelivr.net` 404 —— 所以**本地开发就用 `--local` 指解包仓库副本**。
 *    **CI 上 raw 可直连、没有体积限制，不需要任何额外设置。**
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './lib/http.mjs';
import {
  SERVER_DIR,
  MID_TYPES,
  MID_LABEL,
  readDataVersion,
  loadTable,
  loadNames,
  extractMid,
  toBannerMap,
} from './lib/gamedata.mjs';
import { extractModules, extractMemoirs, extractSkins, WINDOW_DAYS } from './lib/gamedata-extras.mjs';
import { orderMeta } from './lib/meta.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const META_FILE = path.join(DATA, 'metadata.json');

const SERVER_LABEL = { sc: '国服', en: '国际服', tc: '繁中服' };
/** 固定三服顺序 —— `metadata.cla` 的键序靠它钉死（键序一变，另一脚本就会看成「有变化」） */
const CLA_SERVERS = ['sc', 'en', 'tc'];
const GAMEDATA_SOURCE = 'https://github.com/ArknightsAssets/ArknightsGamedata';

/* ---------------- 参数 ---------------- */
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valOf = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : null;
};

const CHECK = has('--check') || has('--dry');
const DUMP = has('--dump');
const FORCE = has('--force');
const LOCAL = valOf('--local');
/** 只让 `character_table.json` 走本地的目录（解包仓库副本）—— 见文件头关于 jsDelivr 20MB 的说明 */
const LOCAL_NAMES = valOf('--local-names');
const SERVERS = (valOf('--servers') || 'sc,en,tc')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
/** `--only=mid` 只抽中坚 / `--only=extras` 只抽模组密录皮肤（默认两者都做） */
const ONLY = (valOf('--only') || 'all').trim();
const DO_MID = ONLY === 'all' || ONLY === 'mid';
const DO_EXTRAS = ONLY === 'all' || ONLY === 'extras';

/** 生成日 = 本地时区的今天（CI 里 TZ=Asia/Shanghai，与既有 generatedAt 口径一致） */
const todayLocal = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

/* ---------------- 对撞用的小工具 ---------------- */
const parseDay = (s) => Date.parse(`${s}T00:00:00Z`);
const dayDiff = (a, b) => Math.abs(parseDay(a) - parseDay(b)) / 864e5;
const upKey = (u) => `${u.name}|${u.rarity}|${u.isShop ? 1 : 0}`;
const upText = (ups, r) =>
  ups
    .filter((u) => u.rarity === r)
    .map((u) => u.name + (u.isShop ? '*' : ''))
    .join('/') || '—';

/** 两条 UP 名单的相似度：exact（含顺序）/ set（集合相同、顺序不同）/ diff */
function compareUps(a, b) {
  const ka = a.map(upKey);
  const kb = b.map(upKey);
  if (ka.join() === kb.join()) return 'exact';
  if ([...ka].sort().join() === [...kb].sort().join()) return 'set';
  return 'diff';
}

/** 官方条目 ←→ 抓取条目：按「同 type + 开始日最近且 ≤5 天」贪心配对 */
function pairByDate(official, scraped) {
  const pool = scraped.slice();
  const pairs = [];
  for (const o of official) {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < pool.length; i++) {
      if (pool[i].type !== o.type) continue;
      const d = dayDiff(pool[i].startDate, o.startDate);
      if (d <= 5 && d < bestD) {
        bestD = d;
        best = i;
      }
    }
    pairs.push({ official: o, scraped: best >= 0 ? pool.splice(best, 1)[0] : null });
  }
  return { pairs, leftover: pool };
}

/* ---------------- 对撞报告 ---------------- */
function report(server, version, mid, rawScraped) {
  const scraped = Object.entries(rawScraped)
    .map(([id, b]) => ({ id, ...b }))
    .filter((b) => MID_TYPES.includes(b.type))
    .sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
  const official = [...mid.classic, ...mid.clafes];

  console.log(`\n${'─'.repeat(70)}`);
  console.log(
    `${server}（${SERVER_LABEL[server] || server}）  data_version：${version}`
  );
  console.log(`官方 ${official.length} 条（中坚 ${mid.classic.length} / 甄选 ${mid.clafes.length}）｜抓取 ${scraped.length} 条`);

  const details = [];
  for (const type of MID_TYPES) {
    const o = official.filter((b) => b.type === type);
    const s = scraped.filter((b) => b.type === type);
    const { pairs, leftover } = pairByDate(o, s);
    const tally = { exact: 0, set: 0, diff: 0, missing: 0 };
    let shopOk = 0;
    let shopBad = 0;
    for (const { official: ob, scraped: sb } of pairs) {
      if (!sb) {
        tally.missing++;
        details.push(`  [抓取缺失] ${type} ${ob.startDate} ${ob.name}`);
        continue;
      }
      tally[compareUps(ob.upOperators, sb.upOperators)]++;
      for (const r of [6, 5]) {
        const os = ob.upOperators.find((u) => u.rarity === r && u.isShop)?.name ?? null;
        const ss = sb.upOperators.find((u) => u.rarity === r && u.isShop)?.name ?? null;
        os === ss ? shopOk++ : shopBad++;
      }
      details.push(
        `__PAIR__|${type}|${ob.startDate}|${sb.startDate}|${ob.name}|${sb.name}|` +
          `${ob.endDate}|${sb.endDate}|${upText(ob.upOperators, 6)}|${upText(sb.upOperators, 6)}|` +
          `${upText(ob.upOperators, 5)}|${upText(sb.upOperators, 5)}|${compareUps(ob.upOperators, sb.upOperators)}`
      );
    }
    console.log(
      `  · ${MID_LABEL[type]}：官方 ${o.length} / 抓取 ${s.length} → ` +
        `完全一致(含顺序) ${tally.exact}｜集合同·顺序不同 ${tally.set}｜内容不一致 ${tally.diff}｜抓取缺失 ${tally.missing}`
    );
    console.log(`      进店位（6★/5★ 各计一次）：一致 ${shopOk} / 不一致 ${shopBad}`);
    if (leftover.filter((b) => b.type === type).length)
      console.log(
        `      抓取多出来的（官方没有）：` +
          leftover
            .filter((b) => b.type === type)
            .map((b) => `${b.name}(${b.startDate})`)
            .join('、')
      );
  }

  /* ⚠️ 「仅顺序不同」（`set`）**不算问题** —— 官方给的顺序和我们从 wiki 抓来的顺序不一样而已，
     集合与进店位都对得上。真正要人看的只有「内容不一致」（`diff`）与「抓取缺失」（`missing`）。 */
  const problems = details.filter((d) => !d.startsWith('__PAIR__') || d.endsWith('|diff'));
  const orderOnly = details.filter((d) => d.endsWith('|set')).length;
  if (orderOnly) console.log(`      （另有 ${orderOnly} 条仅「UP 名单顺序」不同，集合与进店位都一致，不计为差异）`);
  if (problems.length) {
    console.log('  —— 差异明细（最多 12 条；* = 进店）——');
    for (const d of problems.slice(0, 12)) {
      if (!d.startsWith('__PAIR__')) {
        console.log(d);
        continue;
      }
      const [, type, oSt, sSt, oN, sN, oE, sE, o6, s6, o5, s5, kind] = d.split('|');
      console.log(`  [${kind}] ${MID_LABEL[type]} ${oSt}（官方 ${oN} / 抓取 ${sN}）`);
      console.log(`    官方 ${oSt}~${oE}  6★ ${o6}  5★ ${o5}`);
      console.log(`    抓取 ${sSt}~${sE}  6★ ${s6}  5★ ${s5}`);
    }
    if (problems.length > 12) console.log(`  …另有 ${problems.length - 12} 条`);
  }
  return problems.length;
}

/** 读 `data/operators.json`（extras 的**口径白名单 + 星级**）—— 三服共用同一份 */
async function loadOperatorIndex() {
  const raw = JSON.parse(await fs.readFile(path.join(DATA, 'operators.json'), 'utf8'));
  const names = new Set();
  const rarity = {};
  for (const op of Object.values(raw)) {
    if (!op?.name) continue;
    names.add(op.name);
    rarity[op.name] = op.rarity;
  }
  return { names, rarity };
}

/** 某服本轮 extras 会产出哪些文件（⚠️ **国服不含皮肤** —— 那由 `fetch-skins.mjs` 从 PRTS 出） */
const extrasFilesOf = (server) =>
  ['modules', 'memoirs', ...(server === 'sc' ? [] : ['skins'])].map((k) => `${k}_${server}.json`);

/**
 * 写一个 `{ generatedAt, source, <key>: [...] }` 形状的文件 —— 口径与 `fetch-skins.mjs` 一致：
 * **内容没变就不写盘，`generatedAt` 也不推进**（否则 CI 每周都产生一次空提交）。
 */
async function putStable(name, key, arr, source) {
  const file = path.join(DATA, name);
  let prev = null;
  try {
    prev = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    /* 首次产出 */
  }
  const core = { source, [key]: arr };
  const prevCore = prev ? { source: prev.source ?? null, [key]: prev[key] ?? null } : null;
  if (!FORCE && prevCore !== null && JSON.stringify(prevCore) === JSON.stringify(core)) return false;
  await fs.writeFile(file, JSON.stringify({ generatedAt: todayLocal, ...core }, null, 2) + '\n', 'utf8');
  return true;
}

/** 与已落盘的同名文件逐条比（`--check` 用）；文件还没有就跳过（= 首次产出） */
async function compareWithDisk(name, key, arr) {
  const file = path.join(DATA, name);
  try {
    const old = JSON.parse(await fs.readFile(file, 'utf8'));
    const same = JSON.stringify(old[key] ?? null) === JSON.stringify(arr);
    console.log(
      `  · ${name}：落盘 ${(old[key] || []).length} 条 vs 抽出 ${arr.length} 条 → ${same ? '一致' : '⚠️ 不一致'}`
    );
    return same ? 0 : 1;
  } catch {
    console.log(`  · ${name}：还没有文件（首次产出，跳过对撞）`);
    return 0;
  }
}

/** 读 metadata.json（读不出来返回 null —— 调用方要保证不因此写出残缺文件） */
async function readMeta() {
  try {
    return JSON.parse(await fs.readFile(META_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/* ---------------- 主流程 ---------------- */
async function main() {
  console.log(`官方解包抽取：${CHECK ? '--check（只对撞、不落盘）' : '写盘模式'}`);
  console.log(`数据源：${process.env.GAMEDATA_BASE || 'raw.githubusercontent.com（默认）'}${LOCAL ? `  ｜ 本地副本 ${LOCAL}` : ''}`);

  /* ⚠️ 名字表**一律用 cn 的**：我们三服的 upOperators[].name 统一是简体中文名，
     拿 en/tw 的本地化名去比会全量假不一致（实测 en 0/62、tw 1/54）。
     而且**按需加载** —— `character_table` 有 19MB，被短路跳过时不该白下。 */
  let cnNames = null;
  const nameOf = async () => {
    if (!cnNames) {
      cnNames = await loadNames('cn', { local: LOCAL_NAMES || LOCAL });
      console.log(`cn character_table：${Object.keys(cnNames).length} 个 charId`);
    }
    return cnNames;
  };

  /* `metadata.cla` = 中坚系列元信息的**镜像**（站点左栏「中坚数据更新」读它）。
     ⚠️ 三个 fetch-data 脚本构造 metadata 时用的是**全新对象**，所以它们各自把 `cla` 原样沿用；
     这里先读旧值，是为了「只跑了部分服」（`--servers sc`）时保住另外两服。 */
  const prevMeta = CHECK ? null : await readMeta();
  const claMeta = { source: GAMEDATA_SOURCE };
  for (const s of CLA_SERVERS) {
    const v = prevMeta?.cla?.[s];
    claMeta[s] = { generatedAt: v?.generatedAt ?? null, count: v?.count ?? null };
  }

  /* extras 的口径白名单（`operators.json` = **参与过寻访 UP 的干员**，不是全量五六星名册）——
     官方表里 509 个模组 / 439 位密录远比口径大，靠它筛。只在真的要做 extras 时读。 */
  const OP_INDEX = DO_EXTRAS ? await loadOperatorIndex() : { names: new Set(), rarity: {} };
  if (DO_EXTRAS) console.log(`operators.json：${OP_INDEX.names.size} 位（extras 只收这些干员）`);

  let problems = 0;
  for (const server of SERVERS) {
    const dir = SERVER_DIR[server];
    const file = path.join(DATA, `banners_cla_${server}.json`);
    /* ⚠️ 版本号用**整段文本**（trim 过），不要只取第一行 —— 三服 `data_version.txt` 长这样：
         cn: `Stream://torappu-data/v077/rel77.0` / `Change:123576 on 2026/09/17` / `VersionControl:77.6.0`
         en: `Stream:` / `Change:` / `VersionControl:51.10.0`   ← 首行是空的！
       所以能区分版本的是「整段」（en/tw 靠 `VersionControl`）。 */
    const version = await readDataVersion(dir, { local: LOCAL });
    /** 版本号是多行的（cn 三行、en/tw 首行还是空的），打日志时压成一行 */
    const verShort = version.replace(/\s+/g, ' ').trim();

    let prev = null;
    try {
      prev = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      /* 首次产出 */
    }

    /* ⚠️ **短路**：`data_version.txt` 没变就**整段跳过** —— 连 `character_table` 都不下。
       实测 `data_version` 覆盖所有表变更（**热更新也会推进它**），所以不会漏更新。见预研 §7.1 / §9.2。
       ⚠️ 但**首次产出**时不能短路：基准是中坚文件里的版本号，而 extras 的文件可能还不存在
       （2026-10-06 接入 extras 时就踩到这个），所以再要求「本轮要产出的文件都已落盘」。 */
    let outputsReady = !DO_MID || Boolean(prev);
    if (DO_EXTRAS && outputsReady) {
      for (const n of extrasFilesOf(server)) {
        try {
          await fs.access(path.join(DATA, n));
        } catch {
          outputsReady = false;
        }
      }
    }
    if (!CHECK && !FORCE && outputsReady && prev && prev.dataVersion === version) {
      console.log(`\n${server}：data_version 未变（${verShort}），跳过`);
      /* 短路时 cla 取**文件里的真实值** —— 它才是权威，保证 metadata 与文件永远一致 */
      claMeta[server] = {
        generatedAt: prev.generatedAt ?? null,
        count: Object.keys(prev.banners || {}).length,
      };
      continue;
    }
    if (!CHECK && !FORCE && !outputsReady) {
      console.log(`\n${server}：有文件还没产出过（首次接入）→ 忽略 data_version 短路，全量跑一次`);
    }

    /* ---------------- 抽取 ---------------- */
    let mid = null;
    if (DO_MID) {
      const gacha = await loadTable(dir, 'gacha_table.json', { local: LOCAL });
      mid = extractMid(gacha, await nameOf());
      if (DUMP) {
        console.log(`\n--- ${server} 抽出的前 2 条 ---`);
        console.log(JSON.stringify([...mid.classic.slice(0, 1), ...mid.clafes.slice(0, 1)], null, 1));
      }
    }

    let extras = null;
    if (DO_EXTRAS) {
      const names = await nameOf();
      const ue = await loadTable(dir, 'uniequip_table.json', { local: LOCAL });
      const hb = await loadTable(dir, 'handbook_info_table.json', { local: LOCAL });
      extras = {
        modules: extractModules(ue, names, OP_INDEX.names),
        memoirs: extractMemoirs(hb, names, OP_INDEX.names, OP_INDEX.rarity),
      };
      /* ⚠️ **国服皮肤不在这条线上** —— 它由 `fetch-skins.mjs` 从 PRTS 抓（那里有真实的复刻 /
         下架窗口）。官方只有「首发上架日」这一个点，所以只给 en/tw 出（窗口按 `WINDOW_DAYS` 天兜底）。 */
      if (server !== 'sc') {
        const sk = await loadTable(dir, 'skin_table.json', { local: LOCAL });
        extras.skins = extractSkins(sk, names, OP_INDEX.names);
      }
    }

    /* ---------------- 对撞（--check） ---------------- */
    if (CHECK) {
      if (DO_MID) {
        /* 对撞对象 = **站点实际用的那一套**（`banners_<server>.json` + 合并 `banners_cla_<server>.json`）。
           ⚠️ 2026-10-06 之前这里比的是 wiki 抓取的中坚 —— 那批数据已经不在主文件里了，
           当时的实测结果留档在 `akGachaDocs/resource/官方解包数据（ArknightsGamedata）预研.md` §4。
           现在这条退化成「跑出来的和已落盘的是否一致」的回归检查：正常应是 0 差异。 */
        const raw = JSON.parse(await fs.readFile(path.join(DATA, `banners_${server}.json`), 'utf8'));
        try {
          const prevMid = JSON.parse(await fs.readFile(path.join(DATA, `banners_cla_${server}.json`), 'utf8'));
          if (prevMid.banners) Object.assign(raw, prevMid.banners);
        } catch {
          /* 还没有中坚文件 */
        }
        problems += report(server, version, mid, raw);
      }
      if (DO_EXTRAS) {
        console.log(
          `\n  extras —— 模组 ${extras.modules.length} / 密录 ${extras.memoirs.length}` +
            (extras.skins ? ` / 皮肤 ${extras.skins.length}` : ' / 皮肤（国服走 PRTS，不在此列）')
        );
        for (const key of ['modules', 'memoirs', 'skins']) {
          if (extras[key]) problems += await compareWithDisk(`${key}_${server}.json`, key, extras[key]);
        }
      }
      continue;
    }

    /* ---------------- 落盘 ---------------- */
    if (DO_MID) {
      /* 内容没变就不写（沿用本仓库「不产生空提交」的约定）。
         ⚠️ `generatedAt` / `dataVersion` 是易变字段，**不参与**变化比对 ——
            否则版本号一动就是一次只改两行的空提交。代价：「版本变了但内容没变」时下次还会重下，
            这个代价可接受（见预研 §7.1）。 */
      const banners = toBannerMap(mid);
      const changed = JSON.stringify(prev?.banners || null) !== JSON.stringify(banners);
      if (!changed && !FORCE) {
        console.log(`\n${server}：中坚内容无变化，不写盘（data_version ${verShort}）`);
        claMeta[server] = {
          generatedAt: prev?.generatedAt ?? null,
          count: Object.keys(banners).length,
        };
      } else {
        await fs.writeFile(
          file,
          JSON.stringify(
            {
              generatedAt: todayLocal,
              dataVersion: version,
              source: GAMEDATA_SOURCE,
              banners,
            },
            null,
            2
          ) + '\n',
          'utf8'
        );
        claMeta[server] = { generatedAt: todayLocal, count: Object.keys(banners).length };
        console.log(
          `\n${server}：已写入 data/banners_cla_${server}.json —— 中坚 ${mid.classic.length} / 甄选 ${mid.clafes.length}（data_version ${verShort}）`
        );
      }
    }

    if (DO_EXTRAS) {
      const wrote = [];
      for (const key of ['modules', 'memoirs', 'skins']) {
        if (!extras[key]) continue;
        if (await putStable(`${key}_${server}.json`, key, extras[key], GAMEDATA_SOURCE)) {
          wrote.push(`${key}_${server}.json`);
        }
      }
      console.log(`\n${server}：extras ${wrote.length ? `已写入 ${wrote.join('、')}` : '内容无变化，未写盘'}`);
    }
  }

  if (CHECK) {
    console.log(problems ? `\n⚠️ 共 ${problems} 处差异（见上）` : '\n✅ 对撞全部一致');
    return;
  }

  /* 把中坚元信息镜像进 `metadata.json`（站点左栏「中坚数据更新」用）。
     内容一致就不写 —— 沿用本仓库「不产生空提交」的约定。 */
  if (!prevMeta) {
    console.log('\n⚠️ metadata.json 不存在或读不出来，跳过 cla 更新');
  } else if (JSON.stringify(prevMeta.cla || null) !== JSON.stringify(claMeta)) {
    await fs.writeFile(
      META_FILE,
      JSON.stringify(orderMeta({ ...prevMeta, cla: claMeta }), null, 2) + '\n',
      'utf8'
    );
    console.log('\n· metadata.json：cla 已更新（中坚元信息）');
  } else {
    console.log('\n· metadata.json：cla 无变化');
  }
}

await main();
