/**
 * fetch-gamedata.mjs
 * 从**官方解包数据**（`ArknightsAssets/ArknightsGamedata`）抽取卡池数据。
 *
 * 目前只做**中坚系列**：常驻中坚寻访（`CLASSIC` / `CLASSIC_DOUBLE`）+ 中坚甄选（`FESCLASSIC`）。
 * 其余类型官方**没有干员名单**（单六寻访 35 条全无、常驻标准 233 条仅 10 条有文案…），
 * 仍由 PRTS / wiki.gg / 金山 那几个脚本负责 —— 见预研文档 §3。
 *
 * 输出：
 *   data/banners_mid_<server>.json   常驻中坚寻访 + 中坚甄选（**单独一个文件**，不与
 *                                    `banners_<server>.json` 混写；站点侧合并）
 *
 * 口径的**权威说明**在 `akGachaDocs/resource/官方解包数据（ArknightsGamedata）预研.md`
 * （实测数字、字段语义、目标工作流 §9）。本文件只实现，不再重复论证。
 *
 * 用法：
 *   node scripts/fetch-gamedata.mjs --check            只对撞、不落盘（**先跑这个**）
 *   node scripts/fetch-gamedata.mjs --check --dump     对撞 + 打印抽出来的 JSON
 *   node scripts/fetch-gamedata.mjs                    抽取并写盘（内容没变则不写）
 *
 * 常用选项：
 *   --servers sc,en,tc   只处理指定服务器（默认三服）
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');

const SERVER_LABEL = { sc: '国服', en: '国际服', tc: '繁中服' };

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

/* ---------------- 主流程 ---------------- */
async function main() {
  console.log(`官方解包抽取：${CHECK ? '--check（只对撞、不落盘）' : '写盘模式'}`);
  console.log(`数据源：${process.env.GAMEDATA_BASE || 'raw.githubusercontent.com（默认）'}${LOCAL ? `  ｜ 本地副本 ${LOCAL}` : ''}`);

  /* ⚠️ 名字表**一律用 cn 的**：我们三服的 upOperators[].name 统一是简体中文名，
     拿 en/tw 的本地化名去比会全量假不一致（实测 en 0/62、tw 1/54）。 */
  const cnNames = await loadNames('cn', { local: LOCAL_NAMES || LOCAL });
  console.log(`cn character_table：${Object.keys(cnNames).length} 个 charId`);

  let problems = 0;
  for (const server of SERVERS) {
    const dir = SERVER_DIR[server];
    const version = await readDataVersion(dir, { local: LOCAL });
    const gacha = await loadTable(dir, 'gacha_table.json', { local: LOCAL });
    const mid = extractMid(gacha, cnNames);

    if (DUMP) {
      console.log(`\n--- ${server} 抽出的前 2 条 ---`);
      console.log(JSON.stringify([...mid.classic.slice(0, 1), ...mid.clafes.slice(0, 1)], null, 1));
    }

    if (CHECK) {
      const raw = JSON.parse(await fs.readFile(path.join(DATA, `banners_${server}.json`), 'utf8'));
      problems += report(server, version, mid, raw);
      continue;
    }

    /* 落盘：内容没变就不写（沿用本仓库「不产生空提交」的约定）。
       ⚠️ `generatedAt` / `dataVersion` 是易变字段，**不参与**变化比对 ——
          否则版本号一动就是一次只改两行的空提交。代价：「版本变了但内容没变」时下次还会重下，
          这个代价可接受（见预研 §7.1）。 */
    const banners = toBannerMap(mid);
    const file = path.join(DATA, `banners_mid_${server}.json`);
    let prev = null;
    try {
      prev = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      /* 首次产出 */
    }
    const changed = JSON.stringify(prev?.banners || null) !== JSON.stringify(banners);
    if (!changed && !FORCE) {
      console.log(`\n${server}：内容无变化，不写盘（data_version ${version}）`);
      continue;
    }
    await fs.writeFile(
      file,
      JSON.stringify(
        {
          generatedAt: todayLocal,
          dataVersion: version,
          source: 'https://github.com/ArknightsAssets/ArknightsGamedata',
          banners,
        },
        null,
        2
      ) + '\n',
      'utf8'
    );
    console.log(
      `\n${server}：已写入 data/banners_mid_${server}.json —— 中坚 ${mid.classic.length} / 甄选 ${mid.clafes.length}（data_version ${version}）`
    );
  }

  if (CHECK) console.log(problems ? `\n⚠️ 共 ${problems} 处差异（见上）` : '\n✅ 对撞全部一致');
}

await main();
