/**
 * GitHub 星数（2026-10-28 · 0.1.5 接口收尾）。
 *
 * 设置 → 关于 → 星标胶囊一直在调 `GET /api/github/star`，而后端没有这条路由，
 * 页面只能永远显示 `—`。这里补上同源代理：浏览器不直连 GitHub（CSP connect-src 'self'），
 * token / Cookie 一概不下发。
 *
 * 为什么不走 `src/safe-fetch.js`：目标 URL 完全由 package.json homepage 解析，
 * 没有任何用户输入进入 URL，SSRF 面不存在；面板已有直连固定 API 的先例
 * （`panel/lib/models.js` 的智谱资源包接口）。这里用固定 host + 4 秒超时 +
 * 响应体上限，失败如实回 502，不在 200 里伪装成功。
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../../src/atomic-write.js';

export const STAR_TTL_MS = 5 * 60 * 1000;
const MAX_BODY = 64 * 1024;
const TIMEOUT_MS = 4000;

export function parseRepoFromHomepage(homepage) {
  let u;
  try { u = new URL(String(homepage || '')); } catch { return null; }
  if (!/^(?:www\.)?github\.com$/i.test(u.hostname)) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo)) return null;
  return { owner, repo };
}

function readFixture() {
  const file = process.env.QQBOT_GITHUB_STAR_FIXTURE;
  if (!file) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { fail: true };
  }
}

/**
 * @param {{homepage:string, cacheFile:string, userAgent?:string, now?:()=>number,
 *          ttlMs?:number, fetchImpl?:Function, logger?:{warn?:Function}}} opts
 */
export function createGithubStar({
  homepage, cacheFile, userAgent = 'EstrellaBot-Panel', now = Date.now,
  ttlMs = STAR_TTL_MS, fetchImpl = globalThis.fetch, logger = null,
} = {}) {
  const repo = parseRepoFromHomepage(homepage);
  const warn = (msg) => { try { logger?.warn?.(msg); } catch { /* 日志失败不影响接口 */ } };
  let inflight = null;

  function readCache() {
    if (!cacheFile) return null;
    try {
      const j = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (Number.isSafeInteger(j.count) && j.count >= 0 && Number.isFinite(j.fetchedAt)) {
        return { count: j.count, fetchedAt: j.fetchedAt };
      }
    } catch { /* 没有缓存或缓存坏了：按没有处理 */ }
    return null;
  }

  function writeCache(count) {
    if (!cacheFile) return;
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      writeJsonAtomic(cacheFile, { count, fetchedAt: now(), repo: repo ? `${repo.owner}/${repo.repo}` : '' });
    } catch (e) {
      warn(`星数缓存写入失败：${e.message}`);
    }
  }

  async function fetchCount() {
    const fixture = readFixture();
    if (fixture) {
      if (fixture.fail) return { ok: false, reason: 'upstream_unavailable' };
      const count = Number(fixture.count);
      if (Number.isSafeInteger(count) && count >= 0) return { ok: true, count, cached: false };
      return { ok: false, reason: 'upstream_unavailable' };
    }
    if (!repo) return { ok: false, reason: 'no-repo' };
    if (typeof fetchImpl !== 'function') return { ok: false, reason: 'upstream_unavailable' };

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const r = await fetchImpl(`https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`, {
        method: 'GET',
        redirect: 'manual',
        cache: 'no-store',
        signal: ac.signal,
        headers: {
          'User-Agent': userAgent,
          Accept: 'application/vnd.github+json',
        },
      });
      if (!r || r.status !== 200) return { ok: false, reason: 'upstream_unavailable' };
      const text = await r.text();
      if (text.length > MAX_BODY) return { ok: false, reason: 'upstream_unavailable' };
      const j = JSON.parse(text);
      const count = Number(j.stargazers_count);
      if (!Number.isSafeInteger(count) || count < 0) return { ok: false, reason: 'upstream_unavailable' };
      return { ok: true, count, cached: false };
    } catch {
      return { ok: false, reason: 'upstream_unavailable' };
    } finally {
      clearTimeout(timer);
    }
  }

  async function get() {
    // 夹具模式每次读文件、绕过缓存：测试要在同一进程里翻转 200/502。
    const fixture = readFixture();
    if (fixture) return fetchCount();

    const cache = readCache();
    if (cache && now() - cache.fetchedAt < ttlMs) {
      return { ok: true, count: cache.count, cached: true, fetchedAt: cache.fetchedAt };
    }
    if (inflight) return inflight;
    inflight = (async () => {
      const r = await fetchCount();
      if (!r.ok) return r;
      writeCache(r.count);
      return { ok: true, count: r.count, cached: false, fetchedAt: now() };
    })();
    try {
      return await inflight;
    } finally {
      inflight = null;
    }
  }

  return { get, repo };
}
