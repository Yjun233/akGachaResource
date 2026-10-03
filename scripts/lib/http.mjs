/**
 * lib/http.mjs
 * ----------
 * 让 Node 内置的全局 `fetch`（undici）**遵循系统代理环境变量**
 * （HTTPS_PROXY / https_proxy / HTTP_PROXY / http_proxy）。
 *
 * ⚠️ 为什么需要这个：Node 的全局 fetch **默认不读** http(s)_proxy 环境变量，而 curl /
 * 大多数工具会读。在「直连外网不通、只能走代理」的环境里，脚本直连目标站点会
 * `UND_ERR_CONNECT_TIMEOUT`，但同一台机器上 curl 却能通 —— 这正是 `build:data` 在部分环境
 * 失败的根因（目标域名被解析到一组直连不可达的地址，而 fetch 又不会回退到代理）。
 *
 * 做法：检测到代理变量就 `setGlobalDispatcher(new ProxyAgent(url))`，把全局 dispatcher 换成走代理；
 * 没设代理则什么都不做（保持 Node 默认的直连行为）。副作用发生在**模块加载时**，所以只要在抓取
 * 脚本顶部 `import './lib/http.mjs';`（对 lib/airscript.mjs 是 `'./http.mjs'`）即可，
 * 且必须出现在任何 `fetch` 调用之前。
 *
 * 依赖 `undici`（提供 ProxyAgent）。
 */

import { setGlobalDispatcher, ProxyAgent } from 'undici';

const proxy =
  process.env.HTTPS_PROXY || process.env.https_proxy ||
  process.env.HTTP_PROXY || process.env.http_proxy || '';

if (proxy) {
  try {
    setGlobalDispatcher(new ProxyAgent(proxy));
    console.error(`· 已启用系统代理：${proxy}（Node fetch 默认不读代理变量，这里手动接管）`);
  } catch (e) {
    console.error(`· 代理设置失败，回退直连：${e && e.message}`);
  }
}
