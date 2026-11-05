// 逐跳重定向校验（2026-11-05 · 外部评估 P2）
//   ① 更新清单/安装包：每一跳先过白名单再发请求，禁止目标请求数为 0；
//   ② 扩展浏览：browseLock 必须作为 safeFetch 的逐跳策略传入；
//   ③ 相对 Location、循环、超跳数、缺 Location、查询参数脱敏都要有确定行为。
import { fetchCheckedRedirects } from '../panel/lib/update-download.js';
import { safeFetch } from '../src/safe-fetch.js';
import { createExtFetch } from '../src/ext-fetch.js';

let pass = 0;
const fails = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; return; }
  fails.push(`${name}${extra ? `  → ${extra}` : ''}`);
};

const resp = (status, headers = {}, body = '') => new Response(body, { status, headers });
const allowGithub = (u) => {
  try {
    const h = new URL(u).hostname;
    return h === 'github.com' || h === 'release-assets.githubusercontent.com'
      ? { ok: true }
      : { ok: false, reason: `host 不在白名单：${h}` };
  } catch {
    return { ok: false, reason: 'URL 解析失败' };
  }
};

// ── ① 禁止目标：请求数必须为 0 ─────────────────────────────────────────────
{
  const hits = [];
  const fake = async (u) => {
    hits.push(String(u));
    if (String(u).includes('github.com')) {
      return resp(302, { location: 'https://evil.example/payload.exe' });
    }
    return resp(200, {}, 'should-not-happen');
  };
  let msg = '';
  try {
    await fetchCheckedRedirects('https://github.com/releases/latest/download/x', {
      fetchImpl: fake, validateUrl: allowGithub,
    });
  } catch (e) { msg = e.message; }
  ok('禁止 host 在发请求前被拒（只请求了起点）',
    /不在白名单/.test(msg) && hits.length === 1 && !hits.some((u) => u.includes('evil.example')),
    `${msg} · hits=${hits.join(',')}`);
}

// ── ② 相对 Location + 合法跳转 ───────────────────────────────────────────
{
  const seen = [];
  const hits = [];
  const fake = async (u) => {
    hits.push(String(u));
    if (String(u).endsWith('/redirect')) return resp(302, { location: './manifest.json' });
    return resp(200, { 'content-type': 'application/json' }, '{"ok":true}');
  };
  const r = await fetchCheckedRedirects('https://github.com/x/redirect', {
    fetchImpl: fake,
    validateUrl: (u) => { seen.push(u); return allowGithub(u); },
  });
  const text = await r.res.text();
  ok('相对 Location 按当前 URL 解析，每一跳都校验',
    text === '{"ok":true}' && seen.length === 2 && /\/x\/manifest\.json$/.test(r.finalUrl)
      && hits.length === 2,
    `seen=${seen.join(',')} · final=${r.finalUrl} · hits=${hits.length}`);
}

// ── ③ 循环与超跳数 ───────────────────────────────────────────────────────
{
  const fake = async (u) => (String(u).includes('a') ? resp(302, { location: '/b' }) : resp(302, { location: '/a' }));
  let loopMsg = '';
  try {
    await fetchCheckedRedirects('https://github.com/a', { fetchImpl: fake, validateUrl: allowGithub, maxRedirects: 3 });
  } catch (e) { loopMsg = e.message; }
  ok('循环重定向被拒（不会无限打）', /循环|超过/.test(loopMsg), loopMsg);

  let manyMsg = '';
  let n = 0;
  const many = async () => { n += 1; return resp(302, { location: `/r${n}` }); };
  try {
    await fetchCheckedRedirects('https://github.com/r0', { fetchImpl: many, validateUrl: allowGithub, maxRedirects: 3 });
  } catch (e) { manyMsg = e.message; }
  ok('超过跳数上限被拒', /超过 3 跳/.test(manyMsg) && n === 4, `${manyMsg} · n=${n}`);
}

// ── ④ 缺 Location / 查询参数脱敏 ──────────────────────────────────────────
{
  let msg = '';
  try {
    await fetchCheckedRedirects('https://github.com/x', {
      fetchImpl: async () => resp(302, {}), validateUrl: allowGithub,
    });
  } catch (e) { msg = e.message; }
  ok('3xx 缺 Location 直接报错', /缺少 Location/.test(msg), msg);

  let secretMsg = '';
  try {
    await fetchCheckedRedirects('https://github.com/x?token=TOP-SECRET', {
      fetchImpl: async () => resp(302, { location: 'https://evil.example/y?token=TOP-SECRET' }),
      validateUrl: allowGithub,
    });
  } catch (e) { secretMsg = e.message; }
  ok('错误信息不带签名查询参数', /不在白名单/.test(secretMsg) && !secretMsg.includes('TOP-SECRET'), secretMsg);
}

// ── ⑤ safeFetch 的 urlGuard 每跳生效 ─────────────────────────────────────
{
  const calls = [];
  const r = await safeFetch('https://a.example/one', {
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    request: async (u) => {
      calls.push(u.href);
      return {
        ok: true, status: 302,
        headers: { location: 'https://b.example/two' },
        body: null, bytes: 0,
      };
    },
    urlGuard: (u) => {
      const h = new URL(u).hostname;
      return h === 'a.example' ? { ok: true } : { ok: false, reason: '不在浏览名单' };
    },
    policy: { maxRedirects: 3 },
  });
  ok('safeFetch 的第二跳在发请求前被 urlGuard 拦下',
    r.ok === false && calls.length === 1 && calls[0] === 'https://a.example/one'
      && /不在浏览名单/.test(String(r.detail || '')),
    JSON.stringify({ r, calls }));
}

// ── ⑥ ext-fetch 把 browseLock 作为逐跳策略传下去 ─────────────────────────
{
  const guarded = [];
  const extFetch = createExtFetch({
    lock: { enabled: true, hosts: ['a.example'] },
    // 假 safeFetch 模拟"首跳允许 → 重定向到名单外"：它自己按 opts.urlGuard 逐跳问。
    safeFetchImpl: async (url, opts) => {
      const first = opts.urlGuard('https://a.example/one');
      const second = opts.urlGuard('https://b.example/two');
      guarded.push({ first: first.ok, second: second.ok });
      if (!second.ok) return { ok: false, reason: 'blocked-by-policy', detail: second.reason };
      return { ok: true, status: 200, headers: { 'content-type': 'text/plain' }, body: 'ok', bytes: 2 };
    },
  });
  let denied = '';
  try { await extFetch('https://a.example/one'); } catch (e) { denied = e.message; }
  ok('ext-fetch 把浏览名单逐跳交给 safeFetch（第二跳被拒并抛错）',
    /拦截|拦下/.test(denied) && guarded.length === 1 && guarded[0].first === true && guarded[0].second === false,
    `${denied} · ${JSON.stringify(guarded)}`);

  // 全部在名单内时仍返回真实 Response（不能因为加了策略就把正常抓取弄坏）。
  const okFetch = createExtFetch({
    lock: { enabled: true, hosts: ['a.example'] },
    safeFetchImpl: async (url, opts) => {
      const g = opts.urlGuard('https://a.example/one');
      guarded.push({ first: g.ok, second: true });
      return { ok: true, status: 200, headers: { 'content-type': 'text/plain' }, body: 'ok', bytes: 2 };
    },
  });
  const res = await okFetch('https://a.example/one');
  ok('ext-fetch 正常路径仍返回 Response', (await res.text()) === 'ok', String(res.status));
}

if (fails.length) {
  console.log(`逐跳重定向判据：${pass} 项通过，${fails.length} 项失败`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`逐跳重定向判据：${pass} 项通过，0 项失败`);
