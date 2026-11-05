// 发送许可最终复核（2026-11-05 · 外部评估 P2）
//   ① 纯判据：群/私聊、ownerBypass、空 id；
//   ② 接线：唯一发送边界 bot.sendMsg 上复核；主回复在 hook 之后、sendMsg 之前
//      再做一次同步复核；owner 豁免只由 sayToOwner 显式传。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../scripts/lib/scan-utils.mjs';
import { sendPermissionReason, createGuardedSender } from '../src/send-permission.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
const fails = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; return; }
  fails.push(`${name}${extra ? `  → ${extra}` : ''}`);
};

const gate = (evt) => {
  if (evt.message_type === 'group') return evt.group_id === '100' ? '' : '群不在白名单';
  return evt.user_id === '200' ? '' : '对方不在私聊白名单';
};

ok('群：白名单内放行', sendPermissionReason('group', '100', { gateReason: gate }) === '');
ok('群：撤白名单后被拒', /群不在白名单/.test(sendPermissionReason('group', '101', { gateReason: gate })));
ok('私聊：白名单内放行', sendPermissionReason('private', '200', { gateReason: gate }) === '');
ok('私聊：撤白名单后被拒', /不在私聊白名单/.test(sendPermissionReason('private', '201', { gateReason: gate })));
ok('ownerBypass 只豁免私聊（群发仍要过白名单）',
  sendPermissionReason('private', '201', { ownerBypass: true, gateReason: gate }) === ''
  && /群不在白名单/.test(sendPermissionReason('group', '101', { ownerBypass: true, gateReason: gate })));
ok('空 id 直接拒（不把空串当成某个群）',
  /id 为空/.test(sendPermissionReason('group', '', { gateReason: gate })));

// 行为：发送口在真正 send 之前复核；撤权后零发送，也不记账。
{
  let allow = true;
  const sent = [];
  const records = [];
  const guarded = createGuardedSender({
    send: async (...args) => { sent.push(args); return { ok: true }; },
    gateReason: () => (allow ? '' : '群不在白名单'),
    recordSent: (r) => records.push(r),
  });
  const first = await guarded('group', '100', ['x']);
  allow = false;
  let blocked = null;
  try { await guarded('group', '100', ['y']); } catch (e) { blocked = e; }
  ok('许可通过时真的发送并记账', first.ok === true && sent.length === 1 && records.length === 1);
  ok('撤权后零发送、零记账，且错误可判',
    sent.length === 1 && records.length === 1 && blocked
      && blocked.code === 'PERMISSION_BLOCKED' && /群不在白名单/.test(blocked.reason));
  // ownerBypass 只豁免私聊。
  await guarded('private', '9', ['z'], { ownerBypass: true });
  let groupBypass = null;
  try { await guarded('group', '100', ['w'], { ownerBypass: true }); } catch (e) { groupBypass = e; }
  ok('ownerBypass 私聊放行、群发仍被拒',
    sent.length === 2 && groupBypass && groupBypass.code === 'PERMISSION_BLOCKED');
}

const idx = stripComments(fs.readFileSync(path.join(ROOT, 'src/index.js'), 'utf8'));

ok('发送边界只有一处包装：createGuardedSender',
  (idx.match(/bot\.sendMsg = createGuardedSender\(\{/g) || []).length === 1
  && /send: sendMsgRaw,/.test(idx)
  && /gateReason: \(e\) => brain\.gateReason\(e\),/.test(idx));
ok('主回复保留快路径 + 最终复核各一次',
  (idx.match(/lateSendReason\(/g) || []).length === 2);
const hookAt = idx.indexOf('await sendGuard.check(');
const finalAt = idx.indexOf('const lateFinal = lateSendReason(');
const mainSendAt = idx.indexOf('await bot.sendMsg(scene, id, payload)');
ok('最终复核在 hook 返回之后、真正的 sendMsg 之前',
  hookAt >= 0 && finalAt > hookAt && mainSendAt > finalAt,
  `hook=${hookAt} final=${finalAt} send=${mainSendAt}`);
ok('deliverFromBot 把 ownerBypass 透传到发送边界',
  /async function deliverFromBot\(scene, chatId, text, \{ ownerBypass = false \} = \{\}\)/.test(idx)
  && /await bot\.sendMsg\(scene, String\(chatId\), \[textSegment\(chunks\[i\]\)\], \{ ownerBypass \}\);/.test(idx));
ok('owner 豁免只由 sayToOwner 显式传 true',
  /deliverFromBot\('private', id, text, \{ ownerBypass: true \}\)/.test(idx));

if (fails.length) {
  console.log(`发送许可复核判据：${pass} 项通过，${fails.length} 项失败`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`发送许可复核判据：${pass} 项通过，0 项失败`);
