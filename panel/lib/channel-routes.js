/**
 * 官方通道的**身份绑定与凭据校验**路由（2026-11-06）。
 *
 * 为什么单独成一块：这几条路由写的都是"身份"，而身份写错的后果不是报错，
 * 是**把权限给错人**。所以每一条都在这里把判据写死，而不是散在 `panel/server.js`
 * 的各处分支里：
 *   ① 群号只接受 5–12 位数字，且**一个群号只能绑一个 openid**、
 *      **一个 openid 只能指向一个群号** —— 两条方向都要查，
 *      否则两个官方群会共用同一份记忆与人格（串群是本项目最坏的一类事故）；
 *   ② 设主人 = 往 `owner.qq` 里追加那条 openid。**不伪造数字 QQ 号**，
 *      也绝不按昵称猜 —— 名字会改、也能由陌生人自己填；
 *   ③ 解绑群**不动白名单**：白名单是用户自己的决定，悄悄删掉等于替他做主；
 *   ④ 凭据校验只转述 `scripts/check-official.js` 的输出，面板进程自己不碰 AppSecret。
 *
 * @param {{readConfig:Function, writeConfig:Function, sendJson:Function,
 *          readBody:Function, pushLog:Function, runOfficialCheck:Function}} deps
 */
import { OPENID_SHAPE, GROUP_ID_SHAPE, bindingConflict, planGroupBind } from '../../src/channel-binding.js';
import { sendJson, readBody } from './http-io.js';
import { pushLog } from './runtime-state.js';
import { readConfig, writeConfig } from './config-io.js';

const OWNER_ID_MAX = 32;

export function makeChannelRoutes(deps = {}) {
  const io = {
    readConfig: deps.readConfig || readConfig,
    writeConfig: deps.writeConfig || writeConfig,
    pushLog: deps.pushLog || pushLog,
    runOfficialCheck: deps.runOfficialCheck,
  };

  /** 群 openid → 本地群号。 */
  async function apiChannelBind(req, res) {
    const body = await readBody(req);
    const openid = String(body?.openid ?? '').trim();
    const groupId = String(body?.groupId ?? '').trim();
    if (!OPENID_SHAPE.test(openid)) {
      return reply(res, { ok: false, error: '群 openid 形状不对（应为 8–128 位字母数字）', reason: 'bad-openid' }, 400);
    }
    if (!GROUP_ID_SHAPE.test(groupId)) {
      return reply(res, { ok: false, error: '群号必须是 5–12 位纯数字', reason: 'bad-group-id' }, 400);
    }
    const cfg = io.readConfig() || {};
    cfg.channel = plain(cfg.channel) ? cfg.channel : {};
    cfg.channel.bindings = plain(cfg.channel.bindings) ? cfg.channel.bindings : {};
    const groups = plain(cfg.channel.bindings.groups) ? cfg.channel.bindings.groups : {};
    const conflict = bindingConflict(groups, openid, groupId);
    if (conflict) {
      io.pushLog(`✗ 群绑定被拒（${conflict.reason}）：${conflict.detail}`);
      return reply(res, { ok: false, error: conflict.detail, reason: conflict.reason }, 409);
    }
    const prev = plain(groups[openid]) ? groups[openid] : null;
    const plan = planGroupBind({ groups, openid, groupId, name: prev?.name || '' });
    cfg.channel.bindings.groups = plan.groups;
    // 「同时加进白名单」是默认动作：绑定了群却不加白名单，表现是
    // "我明明绑好了，它还是不理这个群"，而原因藏在另一页里。
    let addedToAllow = false;
    if (body?.addToAllow !== false) {
      cfg.allow = plain(cfg.allow) ? cfg.allow : {};
      const list = Array.isArray(cfg.allow.groups) ? cfg.allow.groups.map(String) : [];
      if (!list.includes(groupId)) {
        list.push(groupId);
        cfg.allow.groups = list;
        addedToAllow = true;
      }
    }
    io.writeConfig(cfg);
    io.pushLog(`✔ 群已绑定：${openid.slice(0, 8)}… → 群号 ${groupId}${addedToAllow ? '（已加入白名单）' : ''}`);
    return reply(res, {
      ok: true, openid, groupId, addedToAllow,
      replaced: prev && prev.localId && prev.localId !== groupId ? prev.localId : '',
      msg: addedToAllow ? '已绑定并加进群白名单' : '已绑定（白名单没动）',
    });
  }

  async function apiChannelUnbind(req, res) {
    const body = await readBody(req);
    const openid = String(body?.openid ?? '').trim();
    if (!OPENID_SHAPE.test(openid)) {
      return reply(res, { ok: false, error: '群 openid 形状不对', reason: 'bad-openid' }, 400);
    }
    const cfg = io.readConfig() || {};
    const groups = plain(cfg.channel?.bindings?.groups) ? cfg.channel.bindings.groups : {};
    const had = plain(groups[openid]) ? groups[openid] : null;
    if (!had) return reply(res, { ok: false, error: '这个群没有绑定记录', reason: 'not-bound' }, 404);
    delete groups[openid];
    cfg.channel.bindings.groups = groups;
    io.writeConfig(cfg);
    // 白名单**故意不动**：那是用户自己的决定，悄悄删掉等于替他做主。
    io.pushLog(`✔ 已解绑群 ${openid.slice(0, 8)}…（群白名单没有动，要撤请去「发言 → 群与身份」）`);
    return reply(res, {
      ok: true, openid,
      msg: '已解绑。白名单与历史数据都没动 —— 之后这个群的消息会按 openid 独立处理。',
    });
  }

  /** 设主人 = 往 owner.qq 追加 openid；撤销只撤 openid 那几条，不碰数字 QQ 号。 */
  async function apiChannelOwner(req, res) {
    const body = await readBody(req);
    const openid = String(body?.openid ?? '').trim();
    if (!OPENID_SHAPE.test(openid)) {
      return reply(res, { ok: false, error: '成员 openid 形状不对', reason: 'bad-openid' }, 400);
    }
    const cfg = io.readConfig() || {};
    cfg.owner = plain(cfg.owner) ? cfg.owner : {};
    const list = Array.isArray(cfg.owner.qq) ? cfg.owner.qq.map((x) => String(x).trim()).filter(Boolean) : [];
    if (body?.remove === true) {
      const next = list.filter((x) => x !== openid);
      if (next.length === list.length) return reply(res, { ok: false, error: '这个人本来就不是主人', reason: 'not-owner' }, 404);
      cfg.owner.qq = next;
      io.writeConfig(cfg);
      io.pushLog(`✔ 已撤销主人：${openid.slice(0, 8)}…`);
      return reply(res, { ok: true, removed: true, msg: '已撤销该主人' });
    }
    if (list.includes(openid)) return reply(res, { ok: true, already: true, msg: '已经是主人了' });
    if (list.length >= OWNER_ID_MAX) {
      return reply(res, { ok: false, error: `主人条目已达上限 ${OWNER_ID_MAX} 个`, reason: 'owner-limit' }, 400);
    }
    list.push(openid);
    cfg.owner.qq = list;
    io.writeConfig(cfg);
    io.pushLog(`✔ 已设为主人：${openid.slice(0, 8)}…（写进 owner.qq，叫醒与私聊都认这一条）`);
    return reply(res, {
      ok: true,
      msg: '已设为主人。注意：这条 openid 只在这台机器人应用下有效，换应用要重新绑一次。',
    });
  }

  /** 凭据校验：起一次性脚本，面板进程自己不碰 AppSecret。 */
  async function apiChannelTest(req, res) {
    if (typeof io.runOfficialCheck !== 'function') {
      return reply(res, { ok: false, error: '自检入口没有接线', reason: 'no-check-runner' }, 500);
    }
    io.pushLog('… 开始官方通道自检');
    const r = await io.runOfficialCheck();
    io.pushLog(r.output || '');
    return reply(res, { ok: r.ok, output: r.output, msg: r.ok ? '官方通道四步都通' : '自检没通过，看下面每一步的原因' });
  }

  function reply(res, obj, code) { return sendJson(res, obj, code); }
  return { apiChannelBind, apiChannelUnbind, apiChannelOwner, apiChannelTest };
}

function plain(v) { return v && typeof v === 'object' && !Array.isArray(v); }
