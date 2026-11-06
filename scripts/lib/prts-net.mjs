/**
 * lib/prts-net.mjs
 * ----------------
 * 「DNS 抽到连不通的节点」专用兜底：多源解析 → 逐个 TCP 探活 → 挑一个真能连上的 IP。
 *
 * ⚠️ 解决的是什么问题（2026-11-06 实证）：
 *   PRTS 是多线 CDN，`prts.wiki` 的 A 记录会因 DNS 源 / 线路不同落在一批完全不同的网段上
 *   （实测本机系统 DNS 给 `119.84.x` 电信、另一台给 `222.192.186.x` 教育网）。
 *   落在本地不可达的那一段时，undici 在**建连阶段**就以
 *   `UND_ERR_CONNECT_TIMEOUT ... timeout: 10000ms` 失败 —— 注意这是 connectTimeout（默认 10s），
 *   **不是** HTTP 响应超时。所以「把 timeout 调成 30/60/90 秒」毫无用处：SYN 没人应答，
 *   等 900 秒也一样；而 5 次重试又都拿着**同一份** DNS 结果去敲同一批死地址，
 *   于是表现为「第一次失败，后面全失败」。
 *
 * 做法：只在这种「连不上」的错误上启用（懒加载，正常抓取零开销）——
 *   ① 同时问 系统 DNS / 腾讯 119.29.29.29 / 114.114.114.114 / 阿里 223.5.5.5 / 三家 DoH，
 *      把 A 记录汇总去重（不同源经常给出不同网段的节点）；
 *   ② 对候选 IP 并发做 TCP 443 探活（2 秒超时）；
 *   ③ 取第一个通的，用 undici 的 `Agent({ connect: { lookup } })` **只对这个域名**钉住，
 *      其余域名照旧走真实解析 —— 见 `pinTo()`。
 *
 * ⚠️ 不碰 `fetch` 本身：`pinTo()` 换的是全局 dispatcher，所以调用方照常 `fetch` 即可
 *    （`setGlobalDispatcher` 对内置 fetch 生效，2026-11-06 实测：钉黑洞 IP 会报同样的
 *    CONNECT_TIMEOUT，钉可用 IP 则 200）。
 * ⚠️ **有代理时不要用**：代理侧自己会解析，钉 IP 反而绕过代理。调用方先用 `http.mjs` 的
 *    `PROXY` 判一下。
 */

import dns from 'node:dns';
import dnsP from 'node:dns/promises';
import net from 'node:net';
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** 备用 UDP 解析源（国内公共 DNS；教育网 / 运营商的本地 DNS 有时会给远端不可达的节点） */
const UDP_SERVERS = ['119.29.29.29', '114.114.114.114', '223.5.5.5'];

/** 备用 DoH 源（UDP 53 被拦或被劫持时的最后一条路；dns.google 在部分网络不通，尽力而为） */
const DOH_SOURCES = [
  ['DoH 223.5.5.5', 'https://223.5.5.5/resolve', { accept: 'application/dns-json' }],
  ['DoH doh.pub', 'https://doh.pub/dns-query', { accept: 'application/dns-json' }],
  ['DoH dns.google', 'https://dns.google/resolve', { accept: 'application/dns-json' }],
];

/** host → { ip, source, at }（成功结果缓存，避免每次失败都重新探活） */
const cache = new Map();

/** host → Promise（**在途合并**：抓取脚本会并发发几个请求，它们同时失败时只探活一次） */
const inflight = new Map();

/** pin 之前的 dispatcher，供 `unpin()` 还原 */
let prevDispatcher = null;

/** 系统 DNS（getaddrinfo） */
async function fromSystem(host) {
  try {
    const list = await dnsP.lookup(host, { all: true, verbatim: true });
    return list.filter((x) => x.family === 4 && IPV4.test(x.address)).map((x) => x.address);
  } catch {
    return [];
  }
}

/** 指定 UDP 解析源 */
function fromUdp(server, host, timeout = 3000) {
  return new Promise((resolve) => {
    const r = new dns.Resolver({ timeout, tries: 1 });
    r.setServers([server]);
    r.resolve4(host, (err, addrs) => resolve(err ? [] : addrs || []));
  });
}

/** JSON 版 DoH（走全局 fetch，此时还没 pin，不会有解析污染）
 *  ⚠️ 超时压到 4s：`collect()` 用 allSettled 等最慢的那家，dns.google 在部分网络直接不通，
 *     若给 6s 会让「兜底」比「正常重试」还慢。 */
async function fromDoh(host, base, headers, timeout = 4000) {
  try {
    const url = `${base}?name=${encodeURIComponent(host)}&type=A`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
    if (!res.ok) return [];
    const json = await res.json();
    return (json.Answer || []).filter((a) => a.type === 1).map((a) => a.data);
  } catch {
    return [];
  }
}

/** 汇总四处解析结果，**按来源顺序**去重（先到的源优先，便于日志说明来源） */
async function collect(host) {
  const tasks = [
    ['系统 DNS', fromSystem(host)],
    ...UDP_SERVERS.map((s) => [`UDP ${s}`, fromUdp(s, host)]),
    ...DOH_SOURCES.map(([name, base, headers]) => [name, fromDoh(host, base, headers)]),
  ];
  const settled = await Promise.allSettled(tasks.map((t) => t[1]));
  const out = [];
  const seen = new Set();
  settled.forEach((r, i) => {
    if (r.status !== 'fulfilled') return;
    for (const ip of r.value) {
      if (!IPV4.test(ip) || seen.has(ip)) continue;
      seen.add(ip);
      out.push({ ip, source: tasks[i][0] });
    }
  });
  return out;
}

/** TCP 探活（只建连、不发数据；通了立刻断开） */
function probe(ip, port = 443, timeout = 2000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: ip, port });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

/**
 * 挑一个能连上的 IP。
 * @param {string} host 目标域名
 * @param {object} [opts]
 * @param {string[]} [opts.exclude] 已知连不上的 IP（调用方把失败过的地址传进来，避免又选中它）
 * @param {number} [opts.port] 探活端口，默认 443
 * @param {number} [opts.probeMs] 单个 IP 的探活超时，默认 2000
 * @param {number} [opts.ttlMs] 成功结果缓存时长，默认 10 分钟
 * @returns {Promise<{ip:string, source:string, at:number}|null>} 全军覆没时返回 null
 */
export async function usableIp(host, { exclude = [], port = 443, probeMs = 2000, ttlMs = 600_000 } = {}) {
  const hit = cache.get(host);
  if (hit && !exclude.includes(hit.ip) && Date.now() - hit.at < ttlMs) return hit;

  /* 同一轮里几个请求同时失败 → 共用一次探活（否则并发 N 个请求就探 N 遍，每次 2~4 秒） */
  const running = inflight.get(host);
  if (running) {
    const shared = await running;
    return shared && !exclude.includes(shared.ip) ? shared : null;
  }

  const task = (async () => {
    const cands = (await collect(host)).filter((c) => !exclude.includes(c.ip));
    if (!cands.length) return null;

    /* 并发探活，再按候选顺序取第一个通的 —— 不用 Promise.race：
       探活总耗时上限就是 probeMs，重排成「谁先回谁赢」反而让来源顺序失去意义。 */
    const flags = await Promise.all(cands.map((c) => probe(c.ip, port, probeMs)));
    const idx = flags.indexOf(true);
    if (idx < 0) return null;

    const pick = { ...cands[idx], at: Date.now() };
    cache.set(host, pick);
    return pick;
  })();

  inflight.set(host, task);
  try {
    return await task;
  } finally {
    inflight.delete(host);
  }
}

/**
 * 把 `host` 钉到指定 IP（其它域名照旧走真实解析）。
 * @returns {import('undici').Dispatcher}
 */
export function pinTo(host, ip, { connectTimeout = 10_000 } = {}) {
  if (!prevDispatcher) prevDispatcher = getGlobalDispatcher();
  const agent = new Agent({
    connect: {
      timeout: connectTimeout,
      /* ⚠️ 必须按 hostname 分流：全局 dispatcher 会被所有请求共用，
         无条件返回固定 IP 会把 DoH / jsDelivr 之类的请求也打到 PRTS 的机器上。 */
      lookup: (hostname, opts, cb) => (
        hostname === host ? cb(null, [{ address: ip, family: 4 }]) : dns.lookup(hostname, opts, cb)
      ),
    },
  });
  setGlobalDispatcher(agent);
  return agent;
}

/** 还原 `pinTo` 之前（或代理）的 dispatcher；没 pin 过则什么都不做 */
export function unpin() {
  if (!prevDispatcher) return;
  setGlobalDispatcher(prevDispatcher);
  prevDispatcher = null;
}

/** 从 undici 的报错里抠出它试过的地址（`attempted addresses: 1.2.3.4:443, ...`） */
export function attemptedAddresses(err) {
  const msg = String(err?.cause?.message || err?.message || '');
  const out = [];
  const re = /(\d{1,3}(?:\.\d{1,3}){3}):\d+/g;
  for (const m of msg.matchAll(re)) out.push(m[1]);
  return out;
}
