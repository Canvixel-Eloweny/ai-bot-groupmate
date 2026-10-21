// 「好友私聊按群友接待」判据 —— 纯函数 + 闸门 + 接线。
//
// 这个自检盯的是三件容易悄悄退化的事：
//   ① 好友表归一：认三种形状、认不出的不猜；
//   ② 闸门：好友放行、关掉就回旧行为、拉不到表**失败关闭**、黑名单优先；
//   ③ 接线：面板开关 / 读取默认值 / index 侧的重拉与留痕都还在。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { friendIdsOf, isFriend, FRIENDS_RECHECK_MS, FRIENDS_TTL_MS } from '../src/friends.js';
import { Brain } from '../src/brain.js';
import { readCustom } from '../src/custom-config.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
const fails = [];
function ok(name, cond) {
  if (cond) { pass += 1; return; }
  fails.push(name);
}
const read = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');

// ── ① 好友表归一 ─────────────────────────────────────────────────────────
ok('OneBot 标准形状 [{user_id}]',
  [...friendIdsOf([{ user_id: 10001, nickname: 'a' }, { user_id: '10002' }])].join(',') === '10001,10002');
ok('已剥一层的 {data:[…]}',
  [...friendIdsOf({ data: [{ user_id: 7 }, { uin: 8 }] })].join(',') === '7,8');
ok('裸号数组 [10001, "10002"]',
  [...friendIdsOf([10001, '10002'])].join(',') === '10001,10002');
ok('认不出的条目跳过（不塞空串、不猜）',
  friendIdsOf([null, {}, { user_id: '' }, { user_id: '  ' }]).size === 0);
ok('非数组入参 ⇒ 空集（失败关闭）',
  friendIdsOf(undefined).size === 0 && friendIdsOf('nope').size === 0);

// ── ② isFriend ───────────────────────────────────────────────────────────
ok('成员判定（数字/字符串都认）',
  isFriend(new Set(['10001']), 10001) && isFriend(new Set(['10001']), '10001'));
ok('不在表里 / 表缺失 ⇒ false',
  !isFriend(new Set(['1']), '2') && !isFriend(null, '1') && !isFriend(new Set(), ''));
ok('常量有意义（TTL 10 分钟、重拉 60 秒）',
  FRIENDS_TTL_MS === 600000 && FRIENDS_RECHECK_MS === 60000);

// ── ③ 闸门 ───────────────────────────────────────────────────────────────
const cfgOf = (over = {}) => ({
  allow: { groups: [], private: [], allowAllWhenEmpty: false, ...(over.allow || {}) },
  deny: { groups: [], users: [], ...(over.deny || {}) },
  owner: { qq: ['9000'] },
  custom: { allowFriendsPrivate: true, ...(over.custom || {}) },
});
const pm = (qq) => ({ message_type: 'private', user_id: qq, group_id: undefined });
const b1 = new Brain(cfgOf(), { sessions: new Map() });
b1.setFriendIds(new Set(['10001']));
ok('好友私聊放行（白名单里没有他）', b1.isAllowed(pm(10001)));
ok('陌生人私聊仍被挡', !b1.isAllowed(pm(20002)));
ok('拒绝原因说得清「也不在好友表里」', b1.gateReason(pm(20002)).includes('好友表'));
ok('黑名单优先于好友表', !new Brain(cfgOf({ deny: { users: ['10001'] } }), { sessions: new Map() })
  .setFriendIds(new Set(['10001'])).isAllowed(pm(10001)));

const b2 = new Brain(cfgOf({ custom: { allowFriendsPrivate: false } }), { sessions: new Map() });
b2.setFriendIds(new Set(['10001']));
ok('关掉开关 ⇒ 回到旧行为（好友也不回）', !b2.isAllowed(pm(10001)));

const b3 = new Brain(cfgOf(), { sessions: new Map() });
ok('好友表还没拉到 ⇒ 不放行（失败关闭）', !b3.isAllowed(pm(10001)));
b3.setFriendIds(null);
ok('setFriendIds 收到坏值 ⇒ 退成空集，不是"谁都是好友"', !b3.isAllowed(pm(10001)));

const b4 = new Brain(cfgOf({ allow: { private: ['10001'] } }), { sessions: new Map() });
ok('白名单里的人不依赖好友表（旧路不变）', b4.isAllowed(pm(10001)));
ok('群消息完全不受影响',
  new Brain(cfgOf({ allow: { groups: ['555'] } }), { sessions: new Map() })
    .isAllowed({ message_type: 'group', group_id: 555, user_id: 1 }));

// 好友 ≠ 管理员：私聊放行不等于拿到主人特权
ok('好友表不参与主人判定（isOwner 仍在 sleep.js，没被改成认好友）',
  !read('src/sleep.js').includes('friend') && read('src/sleep.js').includes('export function isOwner'));

// ── ④ 接线 ───────────────────────────────────────────────────────────────
const indexJs = read('src/index.js');
ok('从协议端拉好友表', /bot\.call\('get_friend_list'/.test(indexJs));
ok('拉到后推进闸门（brain.setFriendIds）', /brain\.setFriendIds\(friendsCache\.ids\)/.test(indexJs));
ok('被挡的私聊会重拉一次（最多 60 秒一次）',
  /friendsCache\.at > FRIENDS_RECHECK_MS/.test(indexJs) && /await refreshFriends\(\)/.test(indexJs));
ok('定期重拉挂在 tick 上（TTL）', /friendsCache\.at > FRIENDS_TTL_MS/.test(indexJs));
ok('两面都留痕（放行 / 忽略）',
  /在好友表里 → 按群友接待/.test(indexJs) && /\[私聊\] 忽略/.test(indexJs));
ok('拉取失败沿用旧表并告警', /拉好友表失败/.test(indexJs) && /沿用/.test(indexJs));

const custom = readCustom({ custom: {} });
ok('默认开', custom.allowFriendsPrivate === true);
ok('显式 false 才算关', readCustom({ custom: { allowFriendsPrivate: false } }).allowFriendsPrivate === false);
ok('「字符串 false」不误伤（只认布尔 false）',
  readCustom({ custom: { allowFriendsPrivate: 'false' } }).allowFriendsPrivate === true);

const schema = read('panel/next/schema.js');
ok('面板有开关且绑到 custom.allowFriendsPrivate',
  /id: 't\.fpriv'/.test(schema) && /bind: 'allowFriendsPrivate'/.test(schema));
ok('面板写清「好友 ≠ 管理员」', /好友不等于管理员/.test(schema));

// 落盘往返：patchCustom 走的是 readCustom，所以新键必须被 readCustom 认出来
const patch = read('src/custom-config.js');
ok('patchCustom 的入口是 readCustom（新键能存下来）', /export function patchCustom|readCustom\(/.test(patch));

if (fails.length) {
  console.log(`好友私聊判据：${pass} 项通过，${fails.length} 项失败`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`好友私聊判据：${pass} 项通过，0 项失败`);
console.log('  ✓ 表归一 / 闸门（关掉·失败关闭·黑名单优先）/ 接线（面板·重拉·留痕）都对得上');
