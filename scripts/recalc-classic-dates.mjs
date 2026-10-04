/**
 * 离线重算 operators.json 里的 **enClassicDate / tcClassicDate**（2026-10-04）。
 *
 * 为什么需要这个脚本：口径从「该干员第一次出现在中坚寻访卡池」（= 轮换 UP 的日期）
 * 换成「按批次表 + 该服实装日判定的转入日期」，但 `fetch-data-en.mjs` / `fetch-data-tc.mjs`
 * 要联网抓 wiki.gg / 金山文档才能跑。判定本身只依赖 operators.json 里已有的
 * `enReleaseDate` / `tcReleaseDate` / `isLimited`，所以能离线重算。
 *
 * ⚠️ **CI 不需要它** —— en / tc 两个抓取脚本已改成用同一套判定（lib/mid-batches.mjs），
 *   每天的例行更新会自己算出同样的值。这个脚本只用于「本地先把数据纠正过来」和
 *   「将来再切口径时的一次性迁移」，跑完可以不管。
 *
 * 用法：node scripts/recalc-classic-dates.mjs [--write]
 *        不加 --write 只打印改动（默认行为，不碰文件）
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MID_BATCHES, makeMidBatchResolver } from './lib/mid-batches.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, '..', 'data', 'operators.json');

const write = process.argv.includes('--write');
const ops = JSON.parse(await fs.readFile(FILE, 'utf8'));

/** 字段名 → 批次表里的服 */
const FIELDS = { enClassicDate: 'en', tcClassicDate: 'tc' };
const changed = { enClassicDate: [], tcClassicDate: [] };

for (const op of Object.values(ops)) {
  for (const [field, server] of Object.entries(FIELDS)) {
    if (!(MID_BATCHES[server] && field in op)) continue;
    const next = makeMidBatchResolver(server)(op);
    const before = op[field] ?? null;
    if (before !== next) {
      op[field] = next;
      const rel = op[MID_BATCHES[server].releaseKey] || '—';
      changed[field].push(`${op.name}（实装 ${rel}） ${before || '—'} → ${next || '—'}`);
    }
  }
}

for (const [field, list] of Object.entries(changed)) {
  console.log(`· ${field}：${list.length} 个变化`);
  for (const x of list) console.log(`    ${x}`);
}

if (!write) {
  console.log('\n（--dry：未写盘）');
} else {
  await fs.writeFile(FILE, `${JSON.stringify(ops, null, 2)}\n`, 'utf8');
  console.log(`\n✓ 已写回 ${path.relative(process.cwd(), FILE)}`);
}
