/**
 * 识图加固判据（2026-11-04）。
 *
 * 跑法：`node test/check-vision.mjs`
 * 覆盖：3 张上限、1.5MB 复用、UA/Referer/Accept、sha256 去重、单张失败回退、
 * 重试一次、data URL 不重复下载、dropped 不含签名 URL、提示词形状，
 * 以及 `safeFetch` 的 headers 只在图片下载时透传。
 */
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const {
  VISION_MAX_IMAGES, VISION_FETCH_ATTEMPTS, VISION_FETCH_HEADERS, VISION_INLINE_MAX_BYTES,
  hostOf, sha256Of, prepareVisionImages, visionNoteFor,
} = await import(`${SRC}vision.js`);
const { imageMimeOf, VIEW_IMAGE_PROMPT, VISION_INLINE_MAX_BYTES: IMG_CAP } = await import(`${SRC}images.js`);
const { safeFetch } = await import(`${SRC}safe-fetch.js`);

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; return; }
  fails.push(detail ? `${name} —— ${detail}` : name);
};

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl2sAAAAASUVORK5CYII=',
  'base64',
);
const u = (n) => `https://img${n}.example.com/a.png?sig=secret-${n}`;

function fakeFetch(results = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const v = results[url];
    return typeof v === 'function' ? v(url, opts) : (v || { ok: false, reason: 'not-found' });
  };
  return { fn, calls };
}

// ── ① 常量与请求头 ──────────────────────────────────────────────────────
ok('最多 3 张', VISION_MAX_IMAGES === 3);
ok('失败重试 1 次（共 2 次尝试）', VISION_FETCH_ATTEMPTS === 2);
ok('复用 images.js 的 1.5MB 内联上限', VISION_INLINE_MAX_BYTES === IMG_CAP && IMG_CAP === 1_500_000);
ok('请求头有桌面 UA / Referer / Accept',
  typeof VISION_FETCH_HEADERS['User-Agent'] === 'string'
  && VISION_FETCH_HEADERS['User-Agent'].includes('Mozilla/5.0')
  && VISION_FETCH_HEADERS.Referer === 'https://im.qq.com/'
  && String(VISION_FETCH_HEADERS.Accept).includes('image/'));
ok('请求头是冻结的，调用方改不动',
  Object.isFrozen(VISION_FETCH_HEADERS));

// ── ② host / hash ───────────────────────────────────────────────────────
ok('hostOf 只给 host，不带签名参数',
  hostOf(u(1)) === 'img1.example.com' && !hostOf(u(1)).includes('secret'));
ok('hostOf 对坏地址不猜', hostOf('not a url') === '' && hostOf('') === '');
ok('sha256Of 对同字节稳定、对不同字节不同',
  sha256Of(PNG) === sha256Of(Buffer.from(PNG))
  && sha256Of(PNG) !== sha256Of(Buffer.concat([PNG, Buffer.from([1])])));

// ── ③ 3 张上限：下载前就截断 ────────────────────────────────────────────
{
  const results = {};
  for (let i = 1; i <= 5; i += 1) {
    results[u(i)] = { ok: true, bytes: Buffer.concat([PNG, Buffer.from([i])]) };
  }
  const { fn, calls } = fakeFetch(results);
  const got = await prepareVisionImages({ list: [u(1), u(2), u(3), u(4), u(5)], imageBytesOf: fn });
  ok('只准备前 3 张，且第 4/5 张根本没下载',
    got.images.length === 3 && calls.length === 3,
    `images=${got.images.length} calls=${calls.length}`);
}

// ── ④ sha256 去重 ───────────────────────────────────────────────────────
{
  const results = { [u(1)]: { ok: true, bytes: PNG }, [u(2)]: { ok: true, bytes: Buffer.from(PNG) } };
  const { fn } = fakeFetch(results);
  const got = await prepareVisionImages({ list: [u(1), u(2)], imageBytesOf: fn });
  ok('相同字节只留一张', got.images.length === 1 && got.dropped.length === 0,
    JSON.stringify({ images: got.images.length, dropped: got.dropped }));
}

// ── ⑤ data URL 不重复下载 ───────────────────────────────────────────────
{
  const dataUrl = `data:image/png;base64,${PNG.toString('base64')}`;
  const { fn, calls } = fakeFetch({});
  const got = await prepareVisionImages({ list: [dataUrl], imageBytesOf: fn });
  ok('data URL 直接解开，不发起下载',
    got.images.length === 1 && got.images[0].startsWith('data:image/png;base64,') && calls.length === 0,
    JSON.stringify({ images: got.images.length, calls: calls.length }));
}

// ── ⑥ 单张失败：回退原 URL + dropped 不带签名 ───────────────────────────
{
  const badUrl = u(9);
  const got = await prepareVisionImages({
    list: [badUrl],
    imageBytesOf: async () => ({ ok: false, reason: 'timeout' }),
  });
  ok('下载失败时原样保留 URL，不把这张图从上下文抹掉',
    got.images.length === 1 && got.images[0] === badUrl);
  ok('dropped 记 host/reason，且不落原始签名 URL',
    got.dropped.length === 1
    && got.dropped[0].host === 'img9.example.com'
    && got.dropped[0].reason === 'timeout'
    && !JSON.stringify(got.dropped).includes('secret-9'),
    JSON.stringify(got.dropped));
}

// ── ⑦ 重试一次 ──────────────────────────────────────────────────────────
{
  let attempts = 0;
  const timeouts = [];
  const got = await prepareVisionImages({
    list: [u(4)],
    imageBytesOf: async (url, opts) => {
      attempts += 1;
      timeouts.push(opts.timeoutMs);
      return attempts === 1 ? { ok: false, reason: 'timeout' } : { ok: true, bytes: PNG };
    },
  });
  ok('第一次失败后重试一次并成功', attempts === 2 && got.images.length === 1 && got.dropped.length === 0,
    `attempts=${attempts} images=${got.images.length}`);
  ok('两档超时是 12s / 20s', timeouts[0] === 12_000 && timeouts[1] === 20_000, JSON.stringify(timeouts));
}

// ── ⑧ 认不出格式：回退原 URL 并记 dropped ───────────────────────────────
{
  const text = Buffer.from('not an image');
  const got = await prepareVisionImages({
    list: [u(5)],
    imageBytesOf: async () => ({ ok: true, bytes: text }),
  });
  ok('认不出图片格式时回退原 URL 并记原因',
    got.images.length === 1 && got.images[0] === u(5)
    && got.dropped.length === 1
    && got.dropped[0].reason === 'unrecognized-image'
    && got.dropped[0].bytes === text.length,
    JSON.stringify(got.dropped));
}

// ── ⑨ 非 http/data 原样保留 ─────────────────────────────────────────────
{
  const local = 'C:\\pics\\a.png';
  const got = await prepareVisionImages({
    list: [local],
    imageBytesOf: async () => { throw new Error('不该下载本地路径'); },
  });
  ok('本地路径原样保留，不误下载', got.images.length === 1 && got.images[0] === local && got.dropped.length === 0);
}

// ── ⑩ 提示词形状 ────────────────────────────────────────────────────────
{
  const note = visionNoteFor(3);
  ok('入站提示带张数、类型优先、看不清与重看',
    note.includes('3 张') && note.includes('先判断') && note.includes('看不清') && note.includes('view_image'));
  ok('没图时不给空提示', visionNoteFor(0) === '');
  ok('看图工具提示词逐项核对',
    VIEW_IMAGE_PROMPT.includes('先判断') && VIEW_IMAGE_PROMPT.includes('看不清') && VIEW_IMAGE_PROMPT.includes('文字'));
}

// ── ⑪ safeFetch 透传图片头（含重定向每一跳）────────────────────────────
{
  const seen = [];
  const res = await safeFetch('https://example.com/a.png', {
    headers: VISION_FETCH_HEADERS,
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    request: async (url, opts) => {
      seen.push({ url: String(url), headers: opts.headers });
      return { ok: true, status: 200, headers: {}, body: PNG, bytes: PNG.length };
    },
  });
  ok('safeFetch 把 headers 传到请求',
    res.ok && seen.length === 1
    && seen[0].headers?.['User-Agent'] === VISION_FETCH_HEADERS['User-Agent']
    && seen[0].headers?.Referer === 'https://im.qq.com/',
    JSON.stringify(seen[0]?.headers));

  let hop = 0;
  const seen2 = [];
  const res2 = await safeFetch('https://example.com/a.png', {
    headers: VISION_FETCH_HEADERS,
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    request: async (url, opts) => {
      hop += 1;
      seen2.push({ url: String(url), headers: opts.headers });
      if (hop === 1) return { ok: true, status: 302, headers: { location: 'https://cdn.example.com/b.png' }, body: Buffer.alloc(0), bytes: 0 };
      return { ok: true, status: 200, headers: {}, body: PNG, bytes: PNG.length };
    },
  });
  ok('重定向每一跳都带同一份图片头',
    res2.ok && seen2.length === 2 && seen2.every((x) => x.headers?.Referer === 'https://im.qq.com/'),
    JSON.stringify(seen2.map((x) => x.headers?.Referer)));
}

if (fails.length) {
  console.log(`识图加固判据：${pass} 项通过，${fails.length} 项失败`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`识图加固判据：${pass} 项通过，0 项失败`);
console.log('  ✓ 3 张 / 1.5MB / UA+Referer / 去重 / 回退 / 重试 / data URL / 提示词 / safeFetch headers 都对得上');
