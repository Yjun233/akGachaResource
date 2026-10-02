/**
 * airscript.mjs
 * -------------
 * **金山文档 AirScript webhook** 的调用封装 —— 繁中服卡池表的云端读取。
 *
 * 背景：繁中服没有 PRTS / wiki.gg 那样的数据站，数据源是人工维护的金山在线表格。
 * 早期做法是「手动导出 xlsx → 本地解析」，但**导出会把日期型单元格整列吞掉**
 * （文本列完好），使解析器 `if (!start) continue` 静默丢掉中坚甄选 / 常驻中坚 /
 * 限时寻访的结束日期。现在改成：在金山文档里贴一段读表脚本、生成「脚本令牌」，
 * 本地与 CI 直接 POST webhook 拿二维数组，彻底绕开导出与 xlsx 中间层。
 *
 * ---------------------------------------------------------------- 端点与鉴权
 *
 *   POST https://www.kdocs.cn/api/v3/ide/file/<file_id>/script/<script_id>/sync_task
 *   Headers: Content-Type: application/json
 *            AirScript-Token: <脚本令牌>
 *   Body:    {"Context":{"argv":{}}}
 *
 * ⚠️ **body 传不进脚本**（2026-10-02 实测）：`Context.sheet_name`、顶层 `sheet_name`、
 *    `Context.argv.sheet_name`、`Context.args.sheet_name` 等形态全试过，脚本里**一律取不到**
 *    —— 数据永远是工作簿的**第一张表**（响应里的 `sheet` 字段可自证）。
 *    所以金山侧脚本改成**一次返回整本工作簿**，由 Node 侧按表名挑（见 `readSheets`）。
 *    **别再试图「按参数选表」，那条路已证伪。**
 *
 * ---------------------------------------------------------------- 响应结构
 *
 * 外层（实测；⚠️ 比说明文档多包了一层 `data`）：
 *
 *   { "data": { "logs": [ … ], "result": { … } }, "error": "", "status": "finished" }
 *
 * `result` 就是金山脚本的返回值：
 *
 *   { "sheets": [ { "sheet": "繁中轮换记录", "rowCount": 200, "colCount": 24, "data": [[…]] }, … ] }
 *
 * `data` 是整张表的二维数组，元素是单元格的**显示文本**（空单元格为 ""），
 * 日期形如 `2020/6/29`（斜杠、不补零）—— 交给 fetch 脚本 `cellDate()` 的字符串分支。
 *
 * ⚠️ 三处与说明文档不符，`parsePayload` 都做了兼容：
 *    ① 外层还有一层 `data`（文档写的是 `{logs, result}`）；
 *    ② `result` 实测**已经是对象**（文档说是「一段 JSON 字符串」，要 parse 两次）；
 *    ③ 返回值是**多张表的数组**（文档只写了单张 `{sheet, rowCount, colCount, data}`）。
 *
 * ⚠️ 金山侧那段脚本在 `scripts/airscript-sheet-reader.js` —— **它不是 Node 脚本**，
 *    要整段粘到金山文档的 AirScript 编辑器里。里面记了几个必须照做的坑（必须显式
 *    `return main()`；`Range.Value` 在那个引擎里是方法、一调用就让引擎崩；正确姿势是
 *    逐格 `Cells(r,c).Text`）。**别凭直觉重写那段脚本。**
 *
 * ---------------------------------------------------------------- 凭证
 *
 * `AIRSCRIPT_TOKEN`（密钥，半年有效）**绝不能硬编码**：env 优先，回退读已 gitignore 的
 * `scripts/.airscript_token`。
 * `TC_KDOCS_FILE_ID` / `TC_KDOCS_SCRIPT_ID` 只是文档标识（会出现在 URL 里），非机密，
 * 所以允许内置默认值 —— 仍然支持用 env 覆盖（CI 上可以放 Repository Variables）。
 * 本地也可以把 file_id 写在 `scripts/.tc_kdocs_file_id`（已 gitignore）。
 *
 * `AIRSCRIPT_API_BASE` 一般不用动，只有本地 mock 测试 / 换域名时才覆盖。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.resolve(__dirname, '..');

/* 文档标识（非机密）。script_id 见金山文档「脚本编辑器 → 脚本信息」里的 URL。 */
export const DEFAULT_FILE_ID = 'cjQ8xxeQp18c';
export const DEFAULT_SCRIPT_ID = 'V2-2uxe1JvtcjeHvzUmkI0vsu';

const DEFAULT_API_BASE = 'https://www.kdocs.cn/api/v3/ide';

/** 读一行纯文本（文件不存在 / 内容为空都返回 ''） */
async function readLine(file) {
  try {
    return (await fs.readFile(file, 'utf8')).trim().split('\n')[0].trim();
  } catch {
    return '';
  }
}

/**
 * 解析运行所需的三件套，按「环境变量 → 本地文件 → 内置默认」的顺序。
 * @returns {Promise<{token:string, fileId:string, scriptId:string, apiBase:string}>}
 * @throws token / script_id 缺失时抛出**带操作指引**的错误（首次配置最容易卡在这）
 */
export async function resolveConfig() {
  const apiBase = (process.env.AIRSCRIPT_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, '');
  const token = process.env.AIRSCRIPT_TOKEN || await readLine(path.join(SCRIPTS_DIR, '.airscript_token'));
  const fileId = process.env.TC_KDOCS_FILE_ID
    || await readLine(path.join(SCRIPTS_DIR, '.tc_kdocs_file_id'))
    || DEFAULT_FILE_ID;
  const scriptId = process.env.TC_KDOCS_SCRIPT_ID || DEFAULT_SCRIPT_ID;

  if (!token) {
    throw new Error(
      '缺少 AirScript 脚本令牌。请在金山文档「脚本编辑器 → 脚本信息 → 生成脚本令牌」拿到后：\n'
      + '  · 本地：把令牌写成一行存进 scripts/.airscript_token（已 gitignore，不会提交）；\n'
      + '  · CI：在仓库 Settings → Secrets and variables → Actions 里加 AIRSCRIPT_TOKEN，'
      + '并在 workflow 里以环境变量注入。',
    );
  }
  if (!scriptId) {
    throw new Error(
      '缺少 script_id（金山文档 AirScript 脚本的标识）。请把 TC_KDOCS_SCRIPT_ID 设为该值，'
      + '或告诉我值、我写进 scripts/lib/airscript.mjs 的 DEFAULT_SCRIPT_ID。',
    );
  }
  return { token, fileId, scriptId, apiBase };
}

const safeParse = (text) => {
  try { return JSON.parse(text); } catch { return null; }
};

/**
 * 响应体 → `{ payload: {表名: 表} }`（成功）或 `{ reason }`（失败，带可读原因）。
 *
 * ⚠️ 两处与说明文档不符（实测），都做了兼容：
 *   ① 外层**多包一层 `data`**：`{ data: { logs, result }, error, status }`；
 *   ② `result` **已经是对象**，不是文档说的「JSON 字符串」。
 * 返回的表以**表名**为键，所以金山侧换一次写法 / 加一张表都不会影响调用方。
 * 另外金山侧脚本忘了 `return main()` 时 `result` 是 `[Undefined]`（数组），取不到表 ——
 * 这时把 `status` / `error` 一起报出来，别让人对着空白干瞪眼。
 */
function parsePayload(text) {
  const root = safeParse(text);
  if (!root || typeof root !== 'object') return { reason: `响应不是 JSON：${text.slice(0, 160)}` };
  const envelope = (root.data && typeof root.data === 'object') ? root.data : root;
  const inner = typeof envelope.result === 'string' ? safeParse(envelope.result) : envelope.result;

  /* 主形态：一次返回整本工作簿 { sheets: [ {sheet, data}, … ] } */
  if (inner && Array.isArray(inner.sheets)) {
    const book = {};
    for (const s of inner.sheets) {
      if (s && typeof s.sheet === 'string' && Array.isArray(s.data)) book[s.sheet] = s;
    }
    if (Object.keys(book).length) return { payload: book };
    /* 认得是整本形态，但一张可用的都没有 —— 把脚本自带的 debug 与逐项错误原样报出来
       （首次配置最常卡在这：按表名取不到就是「找不到这张表」）。 */
    const detail = inner.sheets.map((s) => `${s?.sheet ?? '?'}→${s?.error ?? 'data 不是数组'}`).join('；');
    return {
      reason: `金山脚本返回了整本工作簿，但没有可用的表：${detail}；`
        + `debug=${JSON.stringify(inner.debug ?? {})}`,
    };
  }
  /* 兼容形态：单张表 { sheet, data }（万一金山那边退回旧写法） */
  if (inner && typeof inner.sheet === 'string' && Array.isArray(inner.data)) {
    return { payload: { [inner.sheet]: inner } };
  }

  const err = root.error || envelope.error || '';
  const status = root.status || envelope.status || '?';
  return {
    reason: `响应里没有表格数据（status=${status}${err ? ` / error=${err}` : ''}）`
      + '；若 error 为空，多半是金山脚本忘了 `return main()`，'
      + '或者没按 scripts/airscript-sheet-reader.js 的写法返回 `{ sheets: [...] }`。',
  };
}

/**
 * 调一次 webhook，读回**整本工作簿**。网络失败 / 非 2xx / 解析不出表都会重试（指数退避）。
 * @returns {Promise<Record<string, {sheet:string, rowCount:number, colCount:number, data:any[][]}>>}
 */
export async function fetchWorkbook({
  token, fileId, scriptId, apiBase,
  retries = 3,
  timeoutMs = 120_000,
}) {
  const base = apiBase || DEFAULT_API_BASE;
  const url = `${base}/file/${encodeURIComponent(fileId)}/script/${encodeURIComponent(scriptId)}/sync_task`;
  let lastErr = '';

  for (let i = 1; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'AirScript-Token': token,
        },
        /* ⚠️ body 传不进脚本（见文件头），但格式仍按平台约定发 */
        body: JSON.stringify({ Context: { argv: {} } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await res.text();
      if (!res.ok) {
        lastErr = `HTTP ${res.status}：${body.slice(0, 200)}`;
      } else {
        const { payload, reason } = parsePayload(body);
        if (payload) return payload;
        lastErr = reason;
      }
    } catch (e) {
      lastErr = e?.name === 'TimeoutError' ? `请求超时（${timeoutMs}ms）` : (e?.message || String(e));
    }
    if (i < retries) {
      const wait = 1000 * 2 ** (i - 1);   // 1s → 2s → 4s
      console.warn(`    · 第 ${i} 次读取金山表格失败（${lastErr}），${wait}ms 后重试…`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw new Error(`读取金山表格失败（已重试 ${retries} 次）：${lastErr}`);
}

/**
 * 云端网格 → 解析器吃的二维数组。两件事（都源自踩过的坑）：
 *  ① **去掉完全为空的尾行**（中间的空行不能动 —— 解析函数靠行号定位期次表头）；
 *  ② **每行补齐到最大列数**（解析函数按列索引取字段，列数不齐会静默取到 undefined）。
 */
export function normalizeGrid(grid) {
  const rows = (Array.isArray(grid) ? grid : []).map((r) => (
    Array.isArray(r) ? r.map((v) => (v === null || v === undefined ? '' : String(v))) : []
  ));
  while (rows.length && rows[rows.length - 1].every((c) => c === '')) rows.pop();
  const width = rows.reduce((m, r) => (r.length > m ? r.length : m), 0);
  for (const r of rows) while (r.length < width) r.push('');
  return rows;
}

/**
 * 取需要的几张表 → `{ 表名: 二维数组 }`（读不到的表对应项为 `null`，由调用方决定怎么办）。
 * ⚠️ **只调一次 webhook** —— 金山侧脚本一次返回整本工作簿，这里只是按表名挑。
 * 每张表的行数 / 列数会打印出来，方便排查上游改了表结构。
 */
export async function readSheets(names, config, { quiet = false } = {}) {
  const book = await fetchWorkbook(config);
  const out = {};
  for (const name of names) {
    const s = book[name];
    if (!s) {
      out[name] = null;
      if (!quiet) {
        console.warn(`  · ⚠ 工作簿里没有「${name}」（实际读到：${Object.keys(book).join('、') || '（空）'}）`);
      }
      continue;
    }
    out[name] = normalizeGrid(s.data);
    if (!quiet) console.log(`  · 「${name}」${out[name].length} 行 × ${s.colCount ?? '?'} 列`);
  }
  return out;
}
