#!/usr/bin/env node
/**
 * 事件抓包：直连 OneBot WS，把 NapCat 推过来的每一条事件原样打印。
 * 用来查「@ 了机器人但它没反应」这类问题 —— 判断消息到底有没有到、@ 是怎么表达的。
 *
 * 用法：
 *   node scripts/sniff.js            # 抓 120 秒
 *   node scripts/sniff.js 300        # 抓 300 秒
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DURATION = (Number(process.argv[2]) || 120) * 1000;
const OUT = path.join(ROOT, 'panel', 'sniff.log');

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const wsUrl = cfg?.onebot?.wsUrl || 'ws://127.0.0.1:3001';

fs.writeFileSync(OUT, '');
const out = fs.createWriteStream(OUT, { flags: 'a' });

let selfId = null;
let n = 0;

const say = (s) => {
  process.stdout.write(s + '\n');
  out.write(s + '\n');
};

say(`# 抓包开始 ${new Date().toLocaleString('zh-CN', { hour12: false })}`);
say(`# 目标 ${wsUrl}，持续 ${DURATION / 1000} 秒`);
say('# 现在去群里 @ 一下机器人。\n');

const ws = new WebSocket(wsUrl);

ws.on('open', () => say('# ✅ 已连上协议端，等待事件…\n'));

ws.on('message', (buf) => {
  let p;
  try {
    p = JSON.parse(buf.toString());
  } catch {
    return;
  }
  n += 1;

  // 心跳之类的噪音精简显示
  if (p.post_type === 'meta_event' && p.meta_event_type === 'heartbeat') {
    if (n % 20 === 0) say(`# (心跳 ×${n})`);
    return;
  }

  if (p.post_type === 'meta_event' && p.meta_event_type === 'lifecycle') {
    selfId = String(p.self_id);
    say(`# 登录账号 self_id = ${selfId}`);
  }
  if (p.self_id && !selfId) selfId = String(p.self_id);

  if (p.post_type !== 'message') {
    say(`# [${p.post_type}/${p.notice_type || p.meta_event_type || '?'}] ${JSON.stringify(p).slice(0, 200)}`);
    return;
  }

  const isGroup = p.message_type === 'group';
  const msg = p.message;
  const isArray = Array.isArray(msg);

  say('─'.repeat(64));
  say(`收到消息 #${n}`);
  say(`  场景      : ${isGroup ? '群 ' + p.group_id : '私聊'}   (self_id=${p.self_id})`);
  if (isGroup) {
    say(`  发件人    : ${p.sender?.card || p.sender?.nickname || '?'} (${p.user_id})`);
  }
  say(`  message 类型: ${isArray ? '✅ 数组（正确）' : '⚠️ ' + typeof msg + '（不是数组！）'}`);
  say(`  message 原文: ${JSON.stringify(msg)}`);

  // 按桥接层的逻辑判断一下会不会被认为「被 @ 了」
  let mentioned = false;
  if (Array.isArray(msg)) {
    for (const seg of msg) {
      if (seg?.type === 'at') {
        const q = String(seg.data?.qq ?? '');
        say(`  at 段      : qq=${q}  name=${seg.data?.name ?? '(无)'}  ${q === selfId ? '← 就是机器人本人' : ''}`);
        if (q === String(p.self_id) || q === selfId || q === 'all') mentioned = true;
      }
    }
  }
  const inWhitelist = (cfg.allow?.groups || []).map(String).includes(String(p.group_id));
  const aliases = cfg.trigger?.aliases || [];
  const text = Array.isArray(msg) ? msg.filter((s) => s.type === 'text').map((s) => s.data.text).join('') : String(msg);
  const hitAlias = aliases.filter((a) => text.includes(a));

  say('');
  say(`  ── 桥接层会怎么判 ──`);
  say(`  在群白名单   : ${inWhitelist ? '✅ 是' : '❌ 否（会被直接忽略！）'}`);
  say(`  识别到 @ 本人: ${mentioned ? '✅ 是' : '❌ 否'}`);
  if (hitAlias.length) say(`  文本命中别名 : ✅ ${hitAlias.join('、')}`);
  say(`  → 结论       : ${mentioned || hitAlias.length ? '会回应' : (inWhitelist ? '不会回应（没被识别为点名）' : '不会回应（群不在白名单）')}`);
});

ws.on('error', (e) => say(`# ❌ WebSocket 错误: ${e.message}`));
ws.on('close', (c) => say(`# 连接关闭 (${c})`));

setTimeout(() => {
  say(`\n# 抓包结束，共 ${n} 条事件。详情见 panel/sniff.log`);
  out.end();
  try { ws.close(); } catch {}
  process.exit(0);
}, DURATION);
