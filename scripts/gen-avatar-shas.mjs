#!/usr/bin/env node
/**
 * 生成 `data/avatar_shas.json`：**每个头像文件「最后一次被改动」的那次提交 sha**。
 *
 * 为什么需要它（2026-10-29 用户定）：
 *   站点把头像 URL 固定到 commit sha（`@<sha>/avatars/x.png`）以换取 jsDelivr 的
 *   一年 `immutable` 缓存。但**一个全局 sha** 意味着：只要 `avatars/` 多了一张新图，
 *   sha 一变，**232 张的 URL 全都变** → 每个访客都要重下 4.6 MB。
 *   改成「每个文件各用各的 sha（= 它最后被改动的那次提交）」后，URL 只在**该文件真的变了**
 *   的时候才变 → 新增 2 位干员只需多下 2 张（~40 KB）。
 *   顺带消掉一个坑：以前忘了改站点里的 `AVATARS_SHA`，新干员头像就会 404（2026-10-29 真踩过）。
 *
 * 口径：
 * - 取 **最后一次** 改动（不是首次添加）—— 换源重刷时内容变了，URL 就该变，否则客户端会
 *   用一年前那张旧图。
 * - 只保留**当前存在**的文件；已删掉的不写。
 * - 内容没变**不写盘**（否则每次 CI 都会产生一个只有 generatedAt 变化的提交）。
 * - 本地还没提交的新文件拿不到 sha（git log 里没有）→ 不写进清单，站点会自动退回全局
 *   `AVATARS_SHA`；等这次提交进了仓库，下次跑就会补上。
 *
 * 用法：node scripts/gen-avatar-shas.mjs        （CI 里跟在 build:avatars 后面）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AV_DIR = path.join(ROOT, 'avatars');
const OUT = path.join(ROOT, 'data', 'avatar_shas.json');

if (!fs.existsSync(AV_DIR)) {
  console.error(`找不到头像目录 ${AV_DIR}`);
  process.exit(1);
}

/** 当前存在的头像 → charId 集合 */
const chars = new Set(fs.readdirSync(AV_DIR)
  .filter((f) => f.toLowerCase().endsWith('.png'))
  .map((f) => f.slice(0, -4)));

/** 从 git 历史里取「每个文件最后一次被改动的提交」，新 → 旧扫，先到先得 */
function shasFromGit() {
  let out = '';
  try {
    /* ⚠️ 需要**完整历史**（CI 的 actions/checkout 要设 fetch-depth: 0）。
       `--name-only` 会把每次提交改到的路径列出来，`@@<sha>` 行用来分隔。 */
    out = execFileSync('git', ['log', '--format=@@%H', '--name-only', '--', 'avatars'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    });
  } catch (e) {
    console.warn(`git 读不到历史（${e.message.split('\n')[0]}）→ 本次不更新清单`);
    return null;
  }
  const map = {};
  let sha = '';
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('@@')) { sha = line.slice(2); continue; }
    const m = line.match(/^avatars\/(.+)\.png$/i);
    if (!m || !sha) continue;
    if (map[m[1]]) continue;      // 新 → 旧扫，第一次见到就是「最后一次改动」
    map[m[1]] = sha;
  }
  return map;
}

const fromGit = shasFromGit();
if (fromGit === null) process.exit(0);

/* 只留当前还存在的；按 charId 排序，保证文件内容稳定（方便 review / 比对） */
const avatars = {};
for (const c of [...chars].sort()) if (fromGit[c]) avatars[c] = fromGit[c];

const old = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null;
const oldMap = old?.avatars || {};
const same = JSON.stringify(Object.keys(oldMap).sort().map((k) => [k, oldMap[k]]))
  === JSON.stringify(Object.keys(avatars).map((k) => [k, avatars[k]]));
if (same) {
  console.log(`✓ 头像 sha 清单无变化（${Object.keys(avatars).length} 条），不写盘`);
  process.exit(0);
}

const shas = new Set(Object.values(avatars));
const missing = [...chars].filter((c) => !avatars[c]);
const next = {
  generatedAt: new Date().toISOString().slice(0, 10),
  count: Object.keys(avatars).length,
  /** 不同 sha 的个数 —— 正常情况下很少（每次新增一批只多 1 个） */
  shaCount: shas.size,
  avatars,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(next, null, 1)}\n`, 'utf8');
console.log(`✓ 已写 ${path.relative(ROOT, OUT)}：${next.count} 个头像 / ${shas.size} 个 sha`
  + (missing.length ? `\n  ⚠️ ${missing.length} 个文件还没有提交 sha（本地新增、尚未提交）：${missing.join(', ')}` : ''));
