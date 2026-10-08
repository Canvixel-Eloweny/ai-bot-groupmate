import { maskSecrets } from './egress.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.QQBOT_LOG_LEVEL] ?? LEVELS.info;

/**
 * 写一行日志（B8 · S-LOGMASK：出口前先脱敏）。
 *
 * 脱敏放在**这里**而不是各个调用点，理由很实际：日志会被贴进报告、issue、
 * 聊天窗口；而调用点有几十处，靠"记得抹"是靠不住的 —— 只要漏一处，
 * 一个 Key 就已经出去了，而且**不会有任何提示**。
 *
 * ⚠️ 只抹**凭据类**（sk- / Bearer / JWT / 私钥块 / `key=value`），
 *    **不抹本机路径** —— 日志里的绝对路径绝大多数是本项目自己的，
 *    抹掉之后每次排障都要人肉还原，而它根本不是秘密。详见 src/egress.js。
 */
function emit(level, tag, msg, extra) {
  if (LEVELS[level] < threshold) return;
  const t = new Date().toTimeString().slice(0, 8);
  const line = `${t} [${tag}] ${maskSecrets(String(msg))}`;
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(extra === undefined ? line + '\n' : `${line} ${maskSecrets(safeJson(extra))}\n`);
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function scoped(tag) {
  return {
    debug: (m, e) => emit('debug', tag, m, e),
    info: (m, e) => emit('info', tag, m, e),
    warn: (m, e) => emit('warn', tag, m, e),
    error: (m, e) => emit('error', tag, m, e),
  };
}

export default scoped;
