#!/usr/bin/env node
/**
 * fetch-avatars.mjs
 * 抓取干员头像 → avatars/<charId>.png
 *
 * 来源：yuanyan3060/ArknightsGameResource 的 avatar/<charId>.png（原始 180×180 RGBA）。
 *
 * ⚠️ 为什么不能直链源仓库：
 *   - jsDelivr 对这个仓库**不提供托管**：`fastly/cdn.jsdelivr.net/gh/...` 返回 301 跳回
 *     raw.githubusercontent.com，`gcore/testingcf.jsdelivr.net` 直接 404（仓库太大：
 *     avatar 目录就有 2218 个文件 / 104 MB）。普通小仓库的 /gh/ 通道是正常的，所以
 *     只有落到「自己的小仓库」才能让 jsDelivr 正常托管。
 *   - 而 raw.githubusercontent.com 在国内直连不通（本机实测 http=000）。
 *
 * 所以本脚本走**第三方反代**下载（它们代理 raw.githubusercontent.com）：
 *   ghproxy.net / ghfast.top / gh-proxy.com
 * 反代只是「取文件」的通道，页面运行时读的是我们自己的仓库经 jsDelivr 发出的 CDN 链接。
 *
 * 用法：
 *   node scripts/fetch-avatars.mjs                 # 只拉缺失的（默认 96px）
 *   node scripts/fetch-avatars.mjs --size=180       # 存原图尺寸
 *   node scripts/fetch-avatars.mjs --force          # 全部重拉
 *   node scripts/fetch-avatars.mjs --concurrency=8
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'avatars');
const DATA = path.join(ROOT, 'data', 'operators.json');

const REPO = 'yuanyan3060/ArknightsGameResource';
const BRANCH = 'main';

/**
 * 反代列表（可用 `AVATAR_MIRRORS` 环境变量覆盖，逗号分隔）。
 * **最后会再试一次直连** `raw.githubusercontent.com` —— GitHub Actions 里直连最快；
 * 国内通常连不上，但它失败得很快（连接直接被重置），不会拖慢整体。
 */
const MIRRORS = (process.env.AVATAR_MIRRORS
  ?? 'https://ghproxy.net,https://ghfast.top,https://gh-proxy.com')
  .split(',').map((s) => s.trim()).filter(Boolean);
const CANDIDATES = [...MIRRORS, '']; // '' = 直连

const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/avatar`;
/** m 为空串时直连 */
const urlOf = (m, charId) => (m ? `${m}/${RAW}/${charId}.png` : `${RAW}/${charId}.png`);

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : def;
};
const has = (name) => argv.includes(`--${name}`);

const SIZE = Number(opt('size', 96));
const CONCURRENCY = Number(opt('concurrency', 6));
const FORCE = has('force');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 下载单个文件（依次尝试各个反代） */
async function download(charId) {
  const dest = path.join(OUT_DIR, `${charId}.png`);
  let lastErr;
  for (let round = 0; round < 2; round++) {
    for (const m of CANDIDATES) {
      try {
        const res = await fetch(urlOf(m, charId), {
          signal: AbortSignal.timeout(45000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        /* 校验 PNG 魔数，反代偶尔会返回一段 HTML/错误页 */
        if (!(buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)) {
          throw new Error('不是 PNG');
        }
        await fsp.writeFile(dest, buf);
        return { ok: true, mirror: m, bytes: buf.length };
      } catch (e) {
        lastErr = e;
      }
    }
    await sleep(1200);
  }
  return { ok: false, charId, err: lastErr?.message || '未知' };
}

/** 并发跑一批任务 */
async function pool(items, n, worker) {
  const results = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        results[idx] = await worker(items[idx], idx);
      }
    }),
  );
  return results;
}

/** 找可用的 Python（带 PIL）用于缩图 */
async function findPython() {
  const cands = ['E:/ruanjian/Anaconda3/python.exe', 'python3', 'python'];
  for (const p of cands) {
    try {
      const r = await new Promise((res) => {
        const c = spawn(p, ['-c', 'import PIL; print(PIL.__version__)'], { stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        c.stdout.on('data', (d) => { out += d; });
        c.on('close', (code) => res({ code, out: out.trim() }));
        c.on('error', () => res({ code: 1, out: '' }));
      });
      if (r.code === 0 && r.out) return { py: p, pil: r.out };
    } catch { /* 试下一个 */ }
  }
  return null;
}

async function main() {
  if (!fs.existsSync(DATA)) {
    console.error(`找不到 ${DATA}，请先跑 npm run build:data`);
    process.exit(1);
  }
  await fsp.mkdir(OUT_DIR, { recursive: true });

  const ops = JSON.parse(await fsp.readFile(DATA, 'utf8'));
  const ids = Object.keys(ops);
  const todo = FORCE ? ids : ids.filter((id) => !fs.existsSync(path.join(OUT_DIR, `${id}.png`)));

  console.log(`干员 ${ids.length} 位 · 已有 ${ids.length - todo.length} · 待下载 ${todo.length} · 目标尺寸 ${SIZE}px`);
  if (!todo.length) console.log('（全部已存在，加 --force 可强制重拉）');

  const t0 = Date.now();
  const fails = [];
  if (todo.length) {
    let done = 0;
    await pool(todo, CONCURRENCY, async (id) => {
      const r = await download(id);
      done++;
      if (!r.ok) fails.push(id);
      if (done % 25 === 0 || done === todo.length) {
        process.stdout.write(`  已处理 ${done}/${todo.length}\r`);
      }
    });
    console.log(`  已处理 ${todo.length}/${todo.length}  耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  /* 统一缩图（幂等：已经是 SIZE 的图再缩一次没变化） */
  const py = await findPython();
  if (!py) {
    console.warn('⚠ 没找到带 PIL 的 Python，跳过缩图（头像保持下载的原始 180px）');
  } else {
    console.log(`缩图到 ${SIZE}px（Python ${path.basename(py.py)}，PIL ${py.pil}）…`);
    await new Promise((res) => {
      const c = spawn(py.py, [
        path.join(__dirname, 'resize-avatars.py'),
        OUT_DIR,
        String(SIZE),
      ], { stdio: 'inherit' });
      c.on('close', res);
    });
  }

  const files = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.png'));
  const total = files.reduce((a, f) => a + fs.statSync(path.join(OUT_DIR, f)).size, 0);
  console.log(`\n✓ 完成：avatars/ 共 ${files.length} 张，合计 ${(total / 1048576).toFixed(2)} MB`);
  if (fails.length) {
    console.warn(`⚠ ${fails.length} 张失败：`);
    console.warn('  ' + fails.slice(0, 20).join(', ') + (fails.length > 20 ? ' …' : ''));
    console.warn('  重跑本脚本即可（只会补缺失的）');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
