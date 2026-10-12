/**
 * lib/wiki-gg.mjs
 * ---------------
 * **wiki.gg**（arknights.wiki.gg，国际服 wiki）的公共访问层。
 *
 * 为什么单独抽一个 lib：这份 wiki 现在被**两个**抓取脚本用到 ——
 *   · `fetch-data-en.mjs`（国际服卡池 / 上线日）—— 原来 `api()` 与 `fetchOperatorMap()`
 *     就长在这个脚本里；
 *   · `fetch-data.mjs`（国服脚本）—— 2026-10-12 起用它给 `enName` / `jpName` 兜底：
 *     官方解包（`en` / `jp` 的 `character_table.json`）还没收录的新干员，
 *     **先看 wiki.gg**，wiki 也没有才退到国服 `appellation`（用户 2026-10-12 定）。
 *
 * ⚠️ 本地化名（中 / 日 / 繁 / 英）在 Cargo 里的位置，**别找错表**：
 *   · `Operators` 表**只有** `name` / `dispname` / `original` —— **没有** `jpname`；
 *   · **`OperatorFiles` 表才有** `id`(= charId) / `name` / `cnname` / `jpname` / `twname`；
 *   · `Characters` 表也有 `jpname`，但它是**全角色表**（含剧情 / NPC），
 *     且是按角色名而非 charId 组织的 → 本项目**不用**它（operator 要按 charId 对齐）。
 *   → 所以 `fetchWikiOperatorMap()` 直接 `Operators ⋈ OperatorFiles`，**一个请求同时拿到**
 *     页名（英文名）+ 星级 + `jpname`，不需要再去逐页抓 wikitext。
 * 两个脚本各抄一份 cargoquery 迟早会走偏，所以抽出这一份。
 *
 * ⚠️ 本模块用**全局 `fetch`**。调用方必须在最顶部 `import './lib/http.mjs'`（或 `'./http.mjs'`），
 *    否则「只能走代理」的环境里会直连超时。
 */

/** wiki.gg 的 MediaWiki API 入口 */
export const WIKI_API = 'https://arknights.wiki.gg/api.php';

export const WIKI_HEADERS = {
  'User-Agent': 'akGachaData/1.0 (personal data site; +https://github.com/Yjun233/akGachaData)',
  Accept: 'application/json',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 发一个 API 请求（自带重试）。
 *
 * ⚠️ 固定带上 `formatversion: 2` —— 调用方都按新格式取值
 *    （`cargoquery[].title.xxx`、`parse.wikitext` 是**字符串**而不是 `{ '*': … }`）。
 *
 * @param {Record<string, string|number>} params 查询参数
 * @returns {Promise<object>} 解析后的 JSON
 */
export async function wikiApi(params, { tries = 5 } = {}) {
  const url = `${WIKI_API}?${new URLSearchParams({ ...params, format: 'json', formatversion: '2' })}`;
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: WIKI_HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      const c = e && e.cause;
      const detail = c ? `${c.code || c.name || ''} ${c.message || ''}`.trim() : '';
      console.error(`  · 第 ${i + 1}/${tries} 次请求失败: ${e.message}${detail ? ' ← ' + detail : ''}`);
      await sleep(1200 * (i + 1));
    }
  }
  const c = lastErr && lastErr.cause;
  const tail = c ? `${c.code || c.name || ''} ${c.message || ''}`.trim() : '';
  throw new Error(`请求失败: ${lastErr && lastErr.message}${tail ? ' ← ' + tail : ''}`);
}

/**
 * 干员映射：`Operators ⋈ OperatorFiles` **一次查齐**
 * （干员页名 = 英文名、星级、charId、**日语名**）。
 *
 * ⚠️ `jpname` 在 **`OperatorFiles`** 表里（`Operators` 表没有）—— 见文件头「别找错表」。
 *    它跟页面的 `|jpname=` 是同一份数据，所以**一次请求就够了**，不必再逐页抓 wikitext。
 *
 * ⚠️ 行粒度**不是**一干员一行：多形态干员（阿米娅本体/升变、精英干员的
 *    ac / Stronghold Protocol 变体）在 `OperatorFiles` 里有多个 charId 的行，
 *    还有空页名（正义骑士号这类没有干员页的）与空 charId（新公布未实装）的杂行。
 *    所以这里收**所有**有 charId 的行（4★ 靠它识别星级、静默剔除）。
 * ⚠️ 调用方若要建「英文名 → charId」映射，必须让**本体行**（charId 在 `operators.json`
 *    里）优先占位、变体行只补空位 —— 否则阿米娅会解析到升变形态的 charId
 *    （2026-10-03 实测 482 行）。
 *
 * @returns {Promise<Map<string, {enName: string, rarity: number|null, jpName: string|null}>>}
 *   charId → 页名（= 英文名）/ 星级 / 日语名
 */
export async function fetchWikiOperatorMap() {
  console.log('· 抓取 wiki.gg 干员映射（Operators ⋈ OperatorFiles）...');
  const byCharId = new Map();
  for (let offset = 0; offset < 4000; offset += 500) {
    const json = await wikiApi({
      action: 'cargoquery',
      tables: 'Operators=O,OperatorFiles=F',
      fields: 'O._pageName=page,O.rarity=rarity,F.id=charId,F.jpname=jpName',
      join_on: 'F.name=O.name',
      limit: 500,
      offset,
    });
    const rows = json.cargoquery || [];
    if (!rows.length) break;
    for (const r of rows) {
      const { page, rarity, charId, jpName } = r.title;
      if (!page || !charId || byCharId.has(charId)) continue;
      byCharId.set(charId, {
        enName: page,
        rarity: rarity === '' ? null : Number(rarity),
        jpName: jpName || null,
      });
    }
    if (rows.length < 500) break;
  }
  const withJp = [...byCharId.values()].filter((v) => v.jpName).length;
  console.log(`  → ${byCharId.size} 条 charId 映射（其中 ${withJp} 条带 jpname）`);
  return byCharId;
}
