/**
 * HTTP 收发小工具（第 37 轮 B11b-1 · AR-SERVERSPLIT）
 * ══════════════════════════════════════════════════════════════════════════
 *  为什么这两个函数要单独一层
 * ══════════════════════════════════════════════════════════════════════════
 *  它们是最"没有立场"的东西：给个响应对象就写 JSON，给个请求对象就读 body。
 *  但搬动之前它们的位置很尴尬 —— `sendJson` 写在文件末尾的"静态资源"节，
 *  而文件**开头**的 `denyUnauthorized()`（鉴权拒绝）就要用它。
 *  于是"开头依赖结尾"，依赖矩阵上表现为 `HEAD ⇄ HTTP` 一对循环。
 *
 *  把它们放到 L0，任何层都可以 import，而它们自己不依赖任何面板模块。
 *
 * ⚠️ 本模块零依赖（只用 Node 内置），属依赖图最底层。别给它加面板内的 import。
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * 把 obj 当作 JSON 写回去。
 *
 * 防呆：忘记 `await` 一个 async 函数时，`JSON.stringify(Promise)` 会得到 `undefined`，
 * 前端收到一个空响应 `{}` —— 既没报错也没提示，排查起来极其费时间。这里拦一下。
 */
export function sendJson(res, obj, code = 200) {
  if (obj && typeof obj.then === 'function') {
    obj = { error: '服务端内部错误：返回值未等待（Promise）' };
    code = 500;
  }
  const body = JSON.stringify(obj ?? { error: '服务端没有返回内容' });
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

/**
 * 读完请求体并解析成对象。
 * 恒 resolve（坏 JSON → `{}`，读太多 → destroy）—— 让调用方只关心"拿到了什么"，
 * 不必为每个写路由各写一遍 try/catch。上限 1MB 防的是被塞爆内存。
 */
export function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (c) => {
      if (done) return;
      buf += c;
      if (buf.length > 1e6) {
        // 只 destroy 不 settle 会让 Promise 永不返回（客户端看到的是连接重置，
        // 服务端这条请求也永远挂着）。超限一律按"空对象"交给下游按缺字段拒绝。
        req.destroy();
        finish({});
      }
    });
    req.on('end', () => {
      try { finish(JSON.parse(buf || '{}')); } catch { finish({}); }
    });
    // destroy / 客户端中断都不再发 end —— 这三条是 Promise 唯一的兜底。
    req.on('close', () => finish({}));
    req.on('aborted', () => finish({}));
    req.on('error', () => finish({}));
  });
}

/**
 * 读完请求体，**原样返回字节**（D21 · 扩展包 ZIP 上传）。
 *
 * 为什么不能复用 `readBody`：那条路只解 JSON 且上限 1MB。ZIP 是二进制，
 * 转成 base64 塞进 JSON 会放大 33%（1MiB 的包变 1.37MB，**必然撞上限**），
 * 而为了它去抬高**所有**写路由共用的上限，是拿全局换一个窄需求。
 *
 * ⚠️ 超限时**不 destroy**：destroy 会连"回一句话告诉用户包太大"的机会一起掐掉。
 *    这里改成"丢掉已收的、继续把流读完"，然后如实回一个 too-large ——
 *    内存安全由"不再累积"保证，而不是由"断开连接"保证（对端可能是正常用户）。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {{maxBytes?:number}} [opts]
 * @returns {Promise<{ok:true, buf:Buffer} | {ok:false, error:'too-large'}>}
 */
export function readBodyBuffer(req, { maxBytes = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (c) => {
      if (tooLarge) return; // 已经超了：不再累积，只是把流读完
      size += c.length;
      if (size > maxBytes) { tooLarge = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on('end', () => finish(tooLarge ? { ok: false, error: 'too-large' } : { ok: true, buf: Buffer.concat(chunks) }));
    req.on('aborted', () => finish(tooLarge ? { ok: false, error: 'too-large' } : { ok: false, error: 'aborted' }));
    req.on('error', () => finish(tooLarge ? { ok: false, error: 'too-large' } : { ok: false, error: 'aborted' }));
  });
}

/**
 * 把请求体**流式写到文件**（P1-8 · 2026-10-23）。
 *
 * 为什么不能复用 `readBodyBuffer`：Electron 载荷实测 150–250 MB，`chunks` + `Buffer.concat`
 * 的峰值约 2× 包体；离线更新会在面板进程里直接 OOM，而用户只看到“上传失败”。
 * 这里边读边写，仍然按 maxBytes 封顶；超限/中断会把半份文件删掉，不留 200 MB 垃圾。
 */
export function readBodyToFile(req, { file, maxBytes = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    let size = 0;
    let tooLarge = false;
    let done = false;
    let out = null;
    const cleanup = () => {
      try { out?.destroy(); } catch { /* 已关 */ }
      try { fs.rmSync(file, { force: true }); } catch { /* 已删 */ }
    };
    const finish = (v) => {
      if (done) return;
      done = true;
      if (!v.ok) cleanup();
      resolve(v);
    };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      out = fs.createWriteStream(file, { flags: 'w' });
    } catch (e) {
      finish({ ok: false, error: 'open', message: e && e.message ? e.message : String(e) });
      return;
    }
    out.on('error', (e) => finish({ ok: false, error: 'write', message: e && e.message ? e.message : String(e) }));
    req.on('data', (c) => {
      if (tooLarge || done) return;
      size += c.length;
      if (size > maxBytes) {
        tooLarge = true;
        cleanup();
        return;
      }
      if (!out.write(c)) {
        req.pause();
        out.once('drain', () => req.resume());
      }
    });
    req.on('end', () => {
      if (tooLarge) { finish({ ok: false, error: 'too-large' }); return; }
      out.end(() => finish({ ok: true, size }));
    });
    req.on('aborted', () => finish({ ok: false, error: 'aborted' }));
    req.on('error', () => finish({ ok: false, error: 'aborted' }));
  });
}
