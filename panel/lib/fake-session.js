/**
 * 假 QQ 会话 · **面板侧的虚拟入口**（2026-10-18）
 * ══════════════════════════════════════════════════════════════════════
 *  `scripts/fake-qq.mjs` 一直是个前台脚本：要开一个 cmd 窗口、在里面打字。
 *  于是"没有界面的能力"（插件工具、定时消息、夜间产出）只能靠脚本试 ——
 *  这一层把它挂进面板：起 / 停 / 说话 / 看它回了什么，全在网页上。
 *
 *  它**不重写会话逻辑**：stdin 写一行 = 说一句话（`/private` 之类的斜杠命令
 *  也走同一条 stdin），stdout 一行 = 会话层的一句回显。脚本改了这里不用跟。
 *
 *  ⚠️ 三条硬边界：
 *    ① 同一时刻只许一个会话（两个进程抢同一份 data 会把记忆写乱）；
 *    ② 真机器人在跑且没勾「沙箱数据」⇒ 拒绝 —— 它会和真机器人抢 app\data；
 *    ③ 面板退出时把子进程一起收掉（孤儿会攥着 bridge 锁）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PROGRAM_ROOT, NODE, CONFIG_FILE, DATA_DIR } from './paths.js';

/** 脚本路径。**唯一住处** —— 面板别的地方不许拼这个路径。 */
export const FAKE_SCRIPT = path.join(PROGRAM_ROOT, 'scripts', 'fake-qq.mjs');

/** 回显缓冲。它只是"给人看的终端"，不需要很长；长了这一页会重到能感觉出来。 */
const MAX_LINES = 400;
/** 一句话的上限。真人聊天不会超过它；超了几乎一定是误把脚本/日志粘进来了。 */
const MAX_INPUT = 2000;
/** SIGTERM 之后等多久补 SIGKILL（脚本自己会杀子进程，正常几百毫秒就退了）。 */
const KILL_AFTER_MS = 4000;

const st = {
  child: null,
  pid: 0,
  startedAt: 0,
  opts: null,
  seq: 0,
  lines: [],
  exited: null,
};

function push(raw) {
  // 脚本输出带 ANSI 色（Windows 下 readline 也会夹 \r），终端里无所谓，<pre> 里就是垃圾。
  const text = String(raw).replace(/\u001b\[[0-9;]*m/g, '').replace(/\r+$/, '');
  if (!text.trim()) return;
  st.seq += 1;
  st.lines.push({ n: st.seq, text });
  if (st.lines.length > MAX_LINES) st.lines.splice(0, st.lines.length - MAX_LINES);
}

/** 按行切：子进程的输出不保证一行一次 `data`，半个行拼起来再推。 */
function pipeLines(stream) {
  let tail = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    const parts = (tail + chunk).split('\n');
    tail = parts.pop() ?? '';
    for (const line of parts) push(line);
  });
  stream.on('end', () => { if (tail) { push(tail); tail = ''; } });
}

/** 页面要的形态（只读）。`since` = 上次看到的行号，只回它之后的新行。 */
export function fakeSnapshot(since = 0) {
  const after = Number(since) || 0;
  return {
    running: Boolean(st.child),
    pid: st.pid || 0,
    startedAt: st.startedAt || 0,
    opts: st.opts,
    seq: st.seq,
    lines: st.lines.filter((l) => l.n > after),
    exited: st.exited,
    script: 'scripts/fake-qq.mjs',
  };
}

/**
 * 起一个会话。
 * @param {{offline?:boolean, sandbox?:boolean}} opts
 * @param {{bridgeRunning?:boolean}} env 真机器人在不在跑（由路由层传进来，本模块不查进程）
 * @returns {{ok:boolean, msg:string, pid?:number}}
 */
export function fakeStart(opts = {}, env = {}) {
  if (st.child) return { ok: false, msg: `会话已经在跑了（pid ${st.pid}）—— 要重开先点「停止」` };
  const offline = Boolean(opts.offline);
  const sandbox = Boolean(opts.sandbox);
  if (env.bridgeRunning && !sandbox) {
    return {
      ok: false,
      msg: '真机器人正在跑：假 QQ 会起第二个程序抢同一份 data。先停机器人，或勾上「沙箱数据」（换成空的一份临时 data，坏了不心疼）',
    };
  }
  const args = [FAKE_SCRIPT, ...(offline ? ['--offline'] : []), ...(sandbox ? ['--sandbox'] : [])];
  st.lines = [];
  st.seq = 0;
  st.exited = null;
  st.opts = { offline, sandbox };
  st.startedAt = Date.now();
  push(`$ node ${['scripts/fake-qq.mjs', ...(offline ? ['--offline'] : []), ...(sandbox ? ['--sandbox'] : [])].join(' ')}`);
  if (!fs.existsSync(FAKE_SCRIPT)) {
    st.exited = { code: null, at: Date.now() };
    push(`（找不到脚本：${FAKE_SCRIPT}）`);
    return { ok: false, msg: '找不到 scripts/fake-qq.mjs —— 这份包可能没带工具链' };
  }
  let child;
  try {
    child = spawn(NODE, args, {
      cwd: PROGRAM_ROOT,
      // 用户根由面板传给脚本：安装版的 data/config 不在 repo 根下。
      env: { ...process.env, QQBOT_CONFIG: CONFIG_FILE, QQBOT_DATA_DIR: DATA_DIR },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (e) {
    st.exited = { code: null, at: Date.now() };
    push(`（起不来：${e.message}）`);
    return { ok: false, msg: `起不来：${e.message}` };
  }
  st.child = child;
  st.pid = child.pid || 0;
  pipeLines(child.stdout);
  pipeLines(child.stderr);
  child.on('error', (e) => push(`（进程错误：${e.message}）`));
  child.on('exit', (code, signal) => {
    push(`（会话已退出：code=${code ?? '—'}${signal ? ` signal=${signal}` : ''}）`);
    st.exited = { code, signal, at: Date.now() };
    st.child = null;
    st.pid = 0;
  });
  return { ok: true, msg: `已启动（${offline ? '离线假模型' : '真模型'} · ${sandbox ? '沙箱数据' : '用 app\\data'}）`, pid: st.pid };
}

/**
 * 说一句（斜杠命令也走这里 —— 脚本的 `/private`、`/at` 就是普通 stdin 行）。
 * @returns {{ok:boolean, msg:string}}
 */
export function fakeSend(text) {
  if (!st.child) return { ok: false, msg: '会话没在跑 —— 先点「启动」' };
  // 换行必须拍平：脚本按行读，一句里带换行会被当成"说两句"。
  const line = String(text ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (!line) return { ok: false, msg: '空的一句不发' };
  if (line.length > MAX_INPUT) return { ok: false, msg: `太长（${line.length} 字，上限 ${MAX_INPUT}）—— 真人不会打这么多` };
  try {
    st.child.stdin.write(`${line}\n`);
  } catch (e) {
    return { ok: false, msg: `写给会话失败：${e.message}` };
  }
  push(`  ↑ 你说：${line}`);
  return { ok: true, msg: '已发出' };
}

/** 停。**不 await 退出事件**：面板只负责发信号，真实结果由输出流里的「会话已退出」体现。 */
export function fakeStop() {
  if (!st.child) return { ok: true, msg: '本来就没在跑' };
  const child = st.child;
  try { child.stdin.end(); } catch { /* 已经关了 */ }
  try { child.kill('SIGTERM'); } catch { /* 已经退了 */ }
  const pid = st.pid;
  setTimeout(() => { try { if (st.child === child) child.kill('SIGKILL'); } catch { /* 同上 */ } }, KILL_AFTER_MS);
  return { ok: true, msg: `已发停止信号（pid ${pid}）` };
}

/** 面板自己退出时调用 —— 子进程不许留成孤儿（它会攥着临时锁，下次会话起不来）。 */
export function fakeDispose() {
  if (!st.child) return;
  try { st.child.stdin.end(); st.child.kill('SIGTERM'); } catch { /* 已经退了 */ }
}
