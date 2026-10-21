#!/usr/bin/env node
/**
 * L3 聚合适配层 · 静态契约门（独立于 `check-wb`）。
 *
 * 为什么单开一道门而不是塞进 `check-wb`：
 *   `check-wb` 扫的是"面板 / 平台 / 发布面"这些长期契约；L3 适配层约束的是
 *   **四家后端的语义差异**（失败形状 / 参数顺序 / 能力真值），族不同。
 *   将来若并入 `check-wb`，应另起一段并在这里留下迁移说明，而不是把两族的判据混在一起。
 *
 * 判据原则：只钉**单一决定点**。调用方（`src/index.js` / `panel/server.js`）必须消费
 * 归一层的输出，而不是各自再判一次；否则"同一件事两份真相"会立刻长回来。
 *
 * 退出码：0 = 全过；1 = 有问题；2 = 输入读不到（真空）。
 * 输出末行固定带 `BACKEND_CHECKS=<n>`，供 `scripts/mutate.mjs` 核输入基数。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './lib/scan-utils.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
let checks = 0;
const hit = (ok, msg) => { checks += 1; if (!ok) problems.push(msg); };

function read(rel) {
  try { return stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8')); } catch { return ''; }
}

const reg = read('src/backend/registry.js');
const norm = read('src/backend/normalize.js');
const drv = read('src/backend/driver.js');
const ob = read('src/onebot.js');
const idx = read('src/index.js');
const srv = read('panel/server.js');
const sc = read('panel/lib/state-collector.js');

// ⓪ 输入基数：七份文件缺一份，后面的"没命中"就可能是真空。
for (const [name, src] of [['registry', reg], ['normalize', norm], ['driver', drv], ['onebot', ob],
  ['index', idx], ['server', srv], ['state-collector', sc]]) {
  hit(src.length > 200, `读不到或过短：${name} —— 本门在真空里（不接受"因此没命中"当通过）`);
}

// ① 后端表：LLBot 的 id 必须先试；只有 NapCat 允许自动下载。
hit(/llbot:\s*\{[\s\S]{0,500}?forwardOrder:\s*\['id',\s*'message_id'\]/.test(reg),
  'registry.js 的 LLBot forwardOrder 不是 [id, message_id] —— 两个键都按 resId 解读的家'
  + '必须先喂 resId，先喂整数 message_id 是空转');
hit((reg.match(/autoDownload:\s*true/g) || []).length === 1
  && /napcat:\s*\{[\s\S]{0,500}?autoDownload:\s*true/.test(reg),
  'registry.js 的 autoDownload:true 不是恰好 NapCat 一家 —— 其余三家的许可/鉴权不支持自动下载');

// ①b 自报识别：四家的名字都要能落到各自 id 上（识别不出回 generic，不许猜）。
hit(/if \(s\.includes\('napcat'\)\) return 'napcat';/.test(reg)
  && /if \(s\.includes\('snowluma'\)\) return 'snowluma';/.test(reg)
  && /if \(s\.includes\('llbot'\)/.test(reg) && /return 'llbot';/.test(reg)
  && /if \(s\.includes\('lagrange'\)\) return 'lagrange';/.test(reg),
  'backendOfSelfReport 的四家映射不全 —— 识别错一家，合并转发的参数顺序就跟着错');

// ①c LLBot 的 get_status 必须还是 unknown（未取证不能写成 yes）。
hit(/llbot:\s*\{[\s\S]{0,800}?get_status:\s*'unknown'/.test(reg),
  'LLBot 的 get_status 被标成了 yes/其它 —— 未取证的动作只能写 unknown');

// ①d 后端选择要真的进配置与模板。
const cfgSrc = read('src/config.js');
hit(/backend:\s*normalizeBackend\(raw\.onebot\?\.backend\)/.test(cfgSrc),
  'src/config.js 没有归一 onebot.backend —— 用户配了也不生效');
let example = null;
try { example = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8')); } catch { /* 下面判红 */ }
hit(example?.onebot?.backend === 'auto',
  'config.example.json 的 onebot.backend 不是 auto —— 照着模板配不出后端选择');

// ② 失败语义：status failed / retcode 非 0 / data.status failed / 已知失败文案，四者都算失败。
hit(/const businessFailed = statusFailed \|\| retFailed \|\| dataFailed \|\| msgFailed;/.test(norm),
  'classifyOneBotReply 没把四种失败形态合并成 businessFailed —— 漏任何一种都会把失败当成功');
hit(/data:\s*businessOk\s*\?\s*\(data \?\? null\)\s*:\s*null/.test(norm),
  '业务失败时仍可能把 data 交出去 —— 半份 data 会被上层当成成功内容');

// ③ 能力与自报：一律不信任上游。
hit(/export function selfReportTrustOf\(backendId\)[\s\S]{0,600}?online:\s*false[\s\S]{0,300}?good:\s*false/
  .test(norm), 'selfReportTrustOf 没有把 online/good 一律标 false —— 上游会写死 true');
hit(/canSend:\s*\{\s*image:\s*'untrusted',\s*record:\s*'untrusted'\s*\}/.test(norm),
  'capabilitiesOf 的 canSend 不是 untrusted —— LLBot 的 can_send_* 恒 true，不能当能力真值');

// ④ 合并转发顺序只有一个决定点。
hit(/for \(const key of b\.forwardOrder\)/.test(norm),
  'forwardAttemptsFor 没有遍历后端表的 forwardOrder —— 顺序又回到了调用方手里');
hit(/forwardAttemptsFor\(onebot\.backend/.test(idx) && !/attempts\.push\(\{ via:\s*'message_id'/.test(idx),
  'src/index.js 仍在自己决定 forward 参数顺序（或没接 forwardAttemptsFor）');

// ⑤ 机器人侧的失败判据只许走归一层。
hit((ob.match(/classifyOneBotReply\(payload\)/g) || []).length === 1,
  'src/onebot.js 没有恰好一处 classifyOneBotReply(payload) —— 业务成功判据又分叉了');

// ⑥ 面板 HTTP 侧与机器人共用同一个归一判据。
hit(/classifyOneBotReply\(JSON\.parse\(r\.body\)\)/.test(srv),
  'panel/server.js 的 apiGroups 没有用 classifyOneBotReply —— 面板与机器人各判一次必然漂');

// ⑦ 面板自报投影带后端与信任度。
hit(/backendId,/.test(sc) && /backendLabel:\s*backendLabel\(backendId\)/.test(sc),
  'state-collector.js 的 onebotSelfReport 没下发 backendId/backendLabel');
hit(/selfReportTrust:\s*selfReportTrustOf\(backendId\)/.test(sc),
  'state-collector.js 没下发 selfReportTrust —— 面板会自己再判一遍自报可信度');

// ⑧ 驱动：auto 才问版本；显式配置不问。
hit(/async function detectBackend\(\)/.test(drv) && /client\.call\('get_version_info'/.test(drv),
  'driver.js 的 detectBackend 没问 get_version_info（auto 无从识别）');
hit(/if \(configured !== 'auto'\)/.test(drv),
  'driver.js 的 detectBackend 没先判显式配置 —— 会把用户指定的后端覆盖掉');
hit(/forwardAttemptsFor\(resolved,/.test(drv),
  'driver.js 的 getForwardMsg 没用 resolved 后端的参数顺序');

if (!problems.length) {
  console.log('✓ L3 聚合适配层（2026-10-20）：后端表唯一 · LLBot id 优先 · 只有 NapCat 自动下载 · '
    + '四种失败形态归一 · 自报一律不可信 · forward 顺序只有一个决定点 · 机器人/面板共用判据 · '
    + 'driver auto 才问版本');
} else {
  for (const p of problems) console.log(`✗ ${p}`);
}
console.log(`BACKEND_CHECKS=${checks}`);
process.exit(problems.length ? 1 : 0);
