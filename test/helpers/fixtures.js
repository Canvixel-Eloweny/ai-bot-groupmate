/**
 * `test/smoke.js` 的**共用夹具**（M-06 · 第 11 轮 · 2026-10-05）。
 *
 * 为什么要有这个文件：`smoke.js` 有一万行、几百个用例，其中有三族夹具是**逐字重复**的 ——
 *   · 群消息事件对象（同一份 `{ message_type:'group', group_id:'100000001', … }` 出现十余次）；
 *   · `{ ...sampleConfig(), <覆盖> }`（十余处）；
 *   · 临时文件路径 `path.join(os.tmpdir(), `qqbot-<名>-${process.pid}.<ext>`)`（约四十处）。
 *
 * ⚠️ 重复的代价**不是"看着乱"**，而是"改一处漏一处"：这三族里最贵的是临时路径 ——
 *    `smoke.js` 会 spawn **真入口** `src/index.js`，而一处漏改 env 覆盖 = 测试的假数据
 *    落进**用户真实的数据文件**（`panel/style-profile.json` / `panel/.thinking.json` …）。
 *    本项目实测踩过（见 `test/smoke.js` 里那一大段"为什么每一项都要指走"的注释）。
 *
 * 零依赖（只用 node 内置 + 生产模块）：可以被 smoke 直接 import，也可以被别的测试用。
 */
import os from 'node:os';
import path from 'node:path';
// 配置夹具的**唯一出处**本来是 `scripts/prompt-diff.mjs` 的 `sampleConfig()` ——
// 这里只是把它与"覆盖项"的合并写法收成一处，不另造一份默认值。
import { sampleConfig } from '../../scripts/prompt-diff.mjs';

/** smoke 里到处在用的那个群号（不是真实群号；真实群号只在 `.env` 与哨兵表里）。 */
export const GROUP_ID = '100000001';

/**
 * 临时文件/目录路径 —— 形状与原来逐字一致：`<tmp>/qqbot-<名>-<pid>.<ext>`。
 * `ext` 传 `''` 时**不补点号**（有些是目录）。
 */
export const tmpPath = (name, ext = 'json') =>
  path.join(os.tmpdir(), `qqbot-${name}-${process.pid}${ext ? `.${ext}` : ''}`);

/** `{ ...sampleConfig(), ...over }` —— 覆盖项是**浅合并**（与原来的写法同语义）。 */
export const cfgWith = (over = {}) => ({ ...sampleConfig(), ...over });

/** 群消息事件对象（原来这一行逐字重复了十余次）。 */
export const groupEvt = (over = {}) => ({
  message_type: 'group',
  group_id: GROUP_ID,
  user_id: '2',
  sender: { nickname: '甲' },
  ...over,
});
