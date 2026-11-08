/**
 * QQ 官方机器人通道客户端（2026-11-06）。
 *
 * 对上**长得和 `src/onebot.js` 一样**：`start / stop / sendMsg / call / selfId /
 * connected / healthSnapshot` + `message`/`ready`/`offline`/`stale` 事件。
 * 主链路（聚批、白名单、档位、存档、发送闸、记忆）因此一行都不用改 ——
 * 换嘴不换脑，这是整条通道接入风险面最小的一条路。
 *
 * 三条贯穿全文件的纪律：
 *   ① **不支持就是不支持**：官方没有合并转发、没有历史回查、没有成员列表。
 *      这些动作一律抛带 `unsupported_*` 的错，绝不"返回空数组"或"回一句成功" ——
 *      伪造成功的表现是模型对用户说"我发好了"，而群里什么都没有。
 *   ② **结果不明不重试**：传输失败/超时归为 unknown，不自动重发（重发的代价是群里两条一样的话）。
 *   ③ **身份只用 openid**：绑定表里有本地群号才用它，没有就原样传 openid；
 *      绝不派生假 QQ 号进权限链。
 */

import { EventEmitter } from 'node:events';
import path from 'node:path';
import scoped from '../../logger.js';
import { DATA_DIR } from '../../user-root.js';
import { imageMimeOf } from '../../images.js';
import { CHANNEL_SETUP_HINT, channelIsConfigured } from '../../channel-mode.js';
// openid ↔ 本地群号的映射判据（2026-11-06）：与面板写侧共用同一份 ——
// 两边各判一次的结果就是"面板说绑好了、出站说认不出"。
import { localIdOfGroup, openidOfGroup } from '../../channel-binding.js';
import {
  DIRECT_UPLOAD_MAX_BYTES, FILE_TYPE, MERGE_WINDOW_MS, MSG_TYPE,
  OFFICIAL_BASE, OFFICIAL_WS_URL, assertOfficialWsUrl,
} from './constants.js';
import { OFFICIAL_CODE, officialError } from './errors.js';
import { createOfficialHttp } from './http.js';
import { createTokenManager } from './token.js';
import { createOfficialRest } from './rest.js';
import { OfficialGateway } from './gateway.js';
import { translateInbound, dedupeKeyOf } from './inbound.js';
import { planOutbound, hasNothingToSend } from './outbound.js';
import { createPassiveLedger } from './passive.js';
import { createSeenStore } from './seen-store.js';

const log = scoped('official');

const PENDING_GROUPS_MAX = 50;
const PENDING_MEMBERS_MAX = 120;

export class OfficialClient extends EventEmitter {
  /**
   * @param {{mode?:string, official?:{appId?:string,appSecret?:string}, bindings?:object}} channelCfg
   * @param {{getCfg?:()=>object, base?:string, wsUrl?:string, fetchImpl?:Function,
   *          WebSocketImpl?:Function, dataDir?:string, appIdLabel?:string}} [options]
   */
  constructor(channelCfg = {}, options = {}) {
    super();
    const official = channelCfg.official ?? {};
    this.appId = String(official.appId ?? '').trim();
    this.appSecret = String(official.appSecret ?? '').trim();
    this.configured = channelIsConfigured('official', official);
    this.getCfg = typeof options.getCfg === 'function' ? options.getCfg : null;
    this.initialBindings = channelCfg.bindings && typeof channelCfg.bindings === 'object'
      ? channelCfg.bindings : {};

    this.selfId = '';
    this.selfName = '';
    this.connected = false;
    this.botOffline = false;
    this.botOfflineAt = 0;
    this.lastFrameAt = 0;
    this.connectedAt = 0;
    this.lastError = '';
    this.lastErrorCode = '';
    this.lastSendAt = 0;
    this.stats = {
      received: 0, duplicates: 0, merged: 0, sent: 0, sendFailures: 0,
      activeSends: 0, passiveSends: 0, unsupportedCalls: 0, ignored: 0,
    };
    /** 群 openid → {openid,name,lastAt,memberCount} */
    this.pendingGroups = new Map();
    /** `${groupOpenid}|${memberOpenid}` → {groupOpenid,memberOpenid,nickname,lastAt} */
    this.pendingMembers = new Map();
    /** 群 openid → 群主有没有开「接收所有消息」（只能从事件观察） */
    this.recvAll = new Map();
    /** openid → 昵称，出站降级 @ 用 */
    this.nicknames = new Map();
    /** 已经查过群名的 openid（30 QPM，别每次都问） */
    this.infoTried = new Set();
    this.mergePending = new Map();
    // AT 与全量的合并窗口。默认 800ms（比主链路的连发合并 1.2s 短，不会拖慢聚批），
    // 留一个注入口只为回归能把"等一拍"这件事做短 —— 不是给配置用的。
    this.mergeWindowMs = Number.isFinite(options.mergeWindowMs) && options.mergeWindowMs >= 0
      ? options.mergeWindowMs : MERGE_WINDOW_MS;

    this.http = createOfficialHttp({
      base: options.base ?? OFFICIAL_BASE,
      fetchImpl: options.fetchImpl,
      onWarn: (msg) => { this.lastError = msg; },
    });
    this.tokens = createTokenManager({ appId: this.appId, appSecret: this.appSecret, http: this.http });
    this.rest = createOfficialRest({ http: this.http, tokens: this.tokens });
    this.passive = createPassiveLedger();
    this.seen = createSeenStore({
      file: path.join(options.dataDir ?? DATA_DIR, 'official-seen.json'),
      log,
    });
    this.gateway = new OfficialGateway({
      wsUrl: assertOfficialWsUrl(options.wsUrl ?? OFFICIAL_WS_URL),
      getToken: () => this.tokens.get(),
      WebSocketImpl: options.WebSocketImpl,
      backoffMs: options.backoffMs,
    });
    this.#wireGateway();
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────
  start() {
    if (!this.configured) {
      // 缺凭据就**明说缺凭据**：不连 NapCat、不猜、不静默重试。
      log.warn(`官方通道待配置 —— ${CHANNEL_SETUP_HINT}`);
      this.emit('unconfigured', { hint: CHANNEL_SETUP_HINT });
      return;
    }
    this.seen.load();
    this.gateway.start();
  }

  stop() {
    for (const [, item] of this.mergePending) clearTimeout(item.timer);
    this.mergePending.clear();
    this.gateway.stop();
    this.connected = false;
    this.seen.flush();
  }

  #wireGateway() {
    const g = this.gateway;
    g.on('open', () => {
      this.connected = true;
      this.connectedAt = Date.now();
      this.lastFrameAt = Date.now();
      this.botOffline = false;
    });
    g.on('ready', async ({ user }) => {
      // READY 里的 user.id 是判"这条消息 @ 的是不是我"的依据；拿不到就回查一次 /users/@me。
      const id = String(user?.id ?? '').trim();
      if (id) { this.selfId = id; this.selfName = String(user?.username ?? '').trim() || this.selfName; }
      if (!this.selfId) await this.#fetchBotInfo();
      this.emit('ready', { selfId: this.selfId });
      log.info(`官方通道已就绪：机器人 ${this.selfName || '(无名)'}（id=${this.selfId || '未知'}）`);
    });
    g.on('event', (dispatch) => { this.#onDispatch(dispatch); });
    g.on('close', ({ code, reason }) => {
      this.connected = false;
      this.emit('offline', { reason: `连接关闭（${reason || code}）` });
    });
    g.on('stale', ({ reason }) => {
      this.emit('stale', { reason });
      log.warn(`官方事件流停摆：${reason}`);
    });
    g.on('terminal', ({ code, reason }) => {
      this.connected = false;
      this.botOffline = true;
      this.botOfflineAt = Date.now();
      this.lastError = `机器人已下架或被封禁（${reason}）`;
      this.lastErrorCode = 'official_terminal';
      log.error(`官方通道不再重连：${this.lastError}（这是平台单方面决定，重试没有意义）`);
      this.emit('offline', { reason: this.lastError, terminal: true });
    });
    g.on('auth-error', ({ message, code }) => {
      this.lastError = message;
      this.lastErrorCode = code || OFFICIAL_CODE.auth;
      log.warn(`官方通道鉴权失败：${message}`);
    });
    g.on('resumed', () => log.info('官方通道续传成功（漏掉的事件由平台补发，已走去重）'));
  }

  async #fetchBotInfo() {
    try {
      const info = await this.rest.getBotInfo();
      this.selfId = String(info?.id ?? '').trim() || this.selfId;
      this.selfName = String(info?.username ?? '').trim() || this.selfName;
    } catch (err) {
      this.lastError = String(err?.message || err);
      this.lastErrorCode = String(err?.code || '');
      log.warn(`读取机器人信息失败：${this.lastError}`);
    }
  }

  // ── 入站 ────────────────────────────────────────────────────────────────
  #onDispatch(dispatch) {
    this.lastFrameAt = Date.now();
    this.stats.received += 1;
    const translated = translateInbound(dispatch, {
      selfId: this.selfId,
      appId: this.appId,
      resolveGroupId: (openid) => this.#resolveGroupId(openid),
      resolveUserId: (openid) => openid,
    });

    if (translated.kind === 'ignore') {
      this.stats.ignored += 1;
      if (dispatch?.t && !['HEARTBEAT'].includes(dispatch.t)) log.debug(`官方事件未处理：${dispatch.t}（${translated.reason}）`);
      return;
    }
    if (translated.kind === 'groupStatus') {
      this.#onGroupStatus(translated.official);
      return;
    }

    const key = translated.dedupeKey;
    if (key && this.seen.has(key)) {
      this.stats.duplicates += 1;
      log.debug(`官方重复推送已丢弃：${translated.official.msgId}`);
      return;
    }
    if (key && this.mergePending.has(key)) {
      // AT 与全量到齐：合成一条，@ 语义保住，且只回一次。
      const prev = this.mergePending.get(key);
      clearTimeout(prev.timer);
      this.mergePending.delete(key);
      this.stats.merged += 1;
      this.#emitMerged(prev.translated, translated);
      return;
    }
    if (key) {
      const entry = { translated, timer: setTimeout(() => {
        this.mergePending.delete(key);
        this.#emitTranslated(entry.translated);
      }, this.mergeWindowMs) };
      if (typeof entry.timer.unref === 'function') entry.timer.unref();
      this.mergePending.set(key, entry);
      return;
    }
    this.#emitTranslated(translated);
  }

  #emitMerged(first, second) {
    const keep = String(second.event.raw_message ?? '').length >= String(first.event.raw_message ?? '').length
      ? second : first;
    const other = keep === second ? first : second;
    const atSelf = keep.official.atSelf || other.official.atSelf;
    const hasSelfAt = Array.isArray(keep.event.message)
      && keep.event.message.some((s) => s?.type === 'at' && String(s?.data?.qq ?? '') === this.selfId);
    if (atSelf && !hasSelfAt && this.selfId) {
      keep.event.message = [{ type: 'at', data: { qq: this.selfId } }, ...keep.event.message];
    }
    keep.official.atSelf = Boolean(atSelf);
    this.#emitTranslated(keep);
  }

  #emitTranslated({ event, official }) {
    const key = dedupeKeyOf(this.appId, official.msgId);
    if (key) this.seen.add(key);
    this.passive.noteInbound({
      scene: official.scene,
      chatId: official.scene === 'group' ? official.groupOpenid : official.userOpenid,
      msgId: official.msgId,
      // 窗口起点用**本机收到的时刻**，不用平台的 `timestamp`：
      // 本机时钟比平台快 5 分钟以上时，按事件时间算会让每一条群回复都"超窗"，
      // 症状是通道显示在线、回复却全走主动消息（而主动发言还要群主单独开）——
      // 典型的"看着活着其实哑了"。真超窗由平台自己拒（40034128 已归一），比静默好。
      receivedAt: Date.now(),
    });
    if (official.nickname) this.nicknames.set(
      official.scene === 'group' ? official.memberOpenid : official.userOpenid,
      official.nickname,
    );
    if (official.scene === 'group') {
      this.#notePendingGroup(official.groupOpenid);
      this.#notePendingMember(official.groupOpenid, official.memberOpenid, official.nickname);
    } else {
      this.#notePendingMember('', official.userOpenid, official.nickname);
    }
    this.emit('message', event);
  }

  #onGroupStatus(info) {
    const openid = String(info.groupOpenid ?? '');
    if (!openid) return;
    if (info.type === 'GROUP_MSG_RECEIVE') this.recvAll.set(openid, true);
    if (info.type === 'GROUP_MSG_REJECT') this.recvAll.set(openid, false);
    if (info.type === 'GROUP_ADD_ROBOT') this.#notePendingGroup(openid);
    if (info.type === 'GROUP_DEL_ROBOT') this.pendingGroups.delete(openid);
    this.emit('group-status', info);
    log.info(`官方群状态事件：${info.type} 群 ${openid.slice(0, 8)}…`);
  }

  #notePendingGroup(openid) {
    if (!openid || this.#bindings().groups[openid]) return;
    if (!this.pendingGroups.has(openid) && this.pendingGroups.size >= PENDING_GROUPS_MAX) {
      const oldest = this.pendingGroups.keys().next().value;
      this.pendingGroups.delete(oldest);
    }
    const prev = this.pendingGroups.get(openid) || { openid, name: '', memberCount: 0, lastAt: 0 };
    prev.lastAt = Date.now();
    this.pendingGroups.set(openid, prev);
    // 群名只查一次：这条接口是 30 QPM，逐群轮询迟早把自己限死。
    if (!this.infoTried.has(openid)) {
      this.infoTried.add(openid);
      this.rest.getGroupInfo(openid)
        .then((info) => {
          const item = this.pendingGroups.get(openid) || prev;
          item.name = String(info?.group_name ?? '').slice(0, 64);
          item.memberCount = Number(info?.group_member_num) || 0;
          this.pendingGroups.set(openid, item);
        })
        .catch((err) => { this.infoTried.delete(openid); log.debug(`群名没查到：${err.message}`); });
    }
  }

  #notePendingMember(groupOpenid, memberOpenid, nickname) {
    if (!memberOpenid) return;
    const key = `${groupOpenid}|${memberOpenid}`;
    if (!this.pendingMembers.has(key) && this.pendingMembers.size >= PENDING_MEMBERS_MAX) {
      const oldest = this.pendingMembers.keys().next().value;
      this.pendingMembers.delete(oldest);
    }
    this.pendingMembers.set(key, {
      groupOpenid, memberOpenid, nickname: String(nickname ?? '').slice(0, 40), lastAt: Date.now(),
    });
  }

  // ── 出站 ────────────────────────────────────────────────────────────────
  /**
   * 发送一条消息（段数组）。
   * @returns {Promise<{message_id:string,message_ids:string[],steps:number}>}
   */
  async sendMsg(scene, id, segments) {
    if (!this.configured) throw officialError(OFFICIAL_CODE.unconfigured, CHANNEL_SETUP_HINT);
    const plan = planOutbound(segments, {
      selfId: this.selfId,
      nameOf: (openid) => this.nicknames.get(String(openid)) || '',
    });
    if (plan.unsupported.includes('forward')) {
      throw officialError(OFFICIAL_CODE.unsupportedForward,
        '官方通道不支持合并转发（没有对应端点）；要发长内容请直接用文本');
    }
    if (hasNothingToSend(plan)) {
      throw officialError(OFFICIAL_CODE.unsupportedSegment,
        `官方通道发不出这些段：${plan.unsupported.join('/') || '(空内容)'}`);
    }
    if (plan.unsupported.length) {
      log.warn(`官方通道忽略了不支持的段：${plan.unsupported.join('/')}（其余内容照常发出）`);
    }
    if (plan.degraded.length) {
      log.debug(`出站 @ 降级为正文（官方没有 at 段）：${plan.degraded.slice(0, 3).join(',')}`);
    }

    const groupOpenid = scene === 'group' ? this.#resolveGroupSendTarget(id) : '';
    if (scene === 'group' && !groupOpenid) {
      throw officialError(OFFICIAL_CODE.unknownGroup,
        `不知道群 ${id} 对应的 group_openid —— 在面板「群与身份绑定」里把它绑上，或直接用 openid`);
    }
    const userOpenid = scene === 'private' ? String(id ?? '').trim() : '';
    if (scene === 'private' && !userOpenid) {
      throw officialError(OFFICIAL_CODE.unknownGroup, '私聊目标为空');
    }

    const ids = [];
    let stepIndex = 0;
    for (const step of plan.steps) {
      stepIndex += 1;
      const credential = this.passive.next({
        scene: scene === 'group' ? 'group' : 'private',
        chatId: scene === 'group' ? groupOpenid : userOpenid,
      });
      if (credential) this.stats.passiveSends += 1;
      else {
        this.stats.activeSends += 1;
        log.debug('这次没有可用的被动凭据（窗口过期或次数用尽），按主动消息发');
      }
      let payload;
      try {
        if (step.kind === 'image') {
          const fileInfo = await this.#uploadImage(scene, groupOpenid || userOpenid, step.file);
          payload = { msg_type: MSG_TYPE.media, media: { file_info: fileInfo }, ...(credential || {}) };
        } else {
          payload = { msg_type: MSG_TYPE.text, content: step.content, ...(credential || {}) };
        }
        if (step.referenceId) payload.message_reference = { message_id: step.referenceId };
        const res = scene === 'group'
          ? await this.rest.sendGroupMessage(groupOpenid, payload)
          : await this.rest.sendPrivateMessage(userOpenid, payload);
        const returned = String(res?.id ?? '').trim();
        if (returned) ids.push(returned);
        this.stats.sent += 1;
        this.lastSendAt = Date.now();
      } catch (err) {
        this.stats.sendFailures += 1;
        this.lastError = String(err?.message || err);
        this.lastErrorCode = String(err?.code || '');
        // 部分成功要说清是哪一步失败的：整批重发会在群里出现重复的话。
        err.sentSteps = stepIndex - 1;
        err.totalSteps = plan.steps.length;
        throw err;
      }
    }
    return { message_id: ids[0] || '', message_ids: ids, steps: plan.steps.length };
  }

  sendGroupMsg(groupId, segments) { return this.sendMsg('group', groupId, segments); }
  sendPrivateMsg(userId, segments) { return this.sendMsg('private', userId, segments); }

  async #uploadImage(scene, openid, file) {
    const source = String(file ?? '').trim();
    if (!source) throw officialError(OFFICIAL_CODE.unsupportedSegment, '图片段没有内容');
    if (/^https?:\/\//i.test(source)) {
      const got = await this.rest.uploadGroupFile(openid, {
        file_type: FILE_TYPE.image, url: source, srv_send_msg: false,
      });
      const info = String(got?.file_info ?? '').trim();
      if (!info) throw officialError(OFFICIAL_CODE.business, '上传成功但没有 file_info');
      return info;
    }
    const b64 = source.startsWith('base64://') ? source.slice('base64://'.length) : '';
    if (!b64) {
      throw officialError(OFFICIAL_CODE.unsupportedSegment,
        '官方通道只接受 http(s) 图片或 base64:// 图片（本地路径请先用现有图片工具读成 base64）');
    }
    const bytes = Buffer.from(b64, 'base64');
    if (!imageMimeOf(bytes)) throw officialError(OFFICIAL_CODE.unsupportedSegment, '这不是一张认得的图片');
    if (bytes.length > DIRECT_UPLOAD_MAX_BYTES) {
      throw officialError(OFFICIAL_CODE.tooLong,
        `图片 ${(bytes.length / 1024 / 1024).toFixed(1)}MB 超过官方二进制直传上限 5MB（分片上传本批未做）`);
    }
    const got = await this.rest.uploadGroupFile(openid, {
      file_type: FILE_TYPE.image, file_name: 'image.png', file_data: b64, srv_send_msg: false,
    });
    const info = String(got?.file_info ?? '').trim();
    if (!info) throw officialError(OFFICIAL_CODE.business, '上传成功但没有 file_info');
    return info;
  }

  // ── OneBot 形状的动作面（调用方只认这些名字）────────────────────────────
  async call(action, params = {}) {
    switch (action) {
      case 'send_group_msg':
        return this.sendMsg('group', params.group_id, params.message);
      case 'send_private_msg':
        return this.sendMsg('private', params.user_id, params.message);
      case 'get_login_info':
        if (!this.selfId) await this.#fetchBotInfo();
        return { user_id: this.selfId, nickname: this.selfName };
      case 'get_group_list':
        return this.#groupList();
      case 'get_status':
        return {
          online: this.connected && this.configured,
          good: false, // 自报一律不可信（与 registry 的 UNTRUSTED_CAN_SEND 同一条纪律）
          self_id: this.selfId,
        };
      case 'get_version_info':
        throw officialError(OFFICIAL_CODE.unsupportedBackend,
          '官方通道没有 get_version_info —— 后端身份由 channel.mode 决定，不靠自报识别');
      case 'send_group_forward_msg':
      case 'send_private_forward_msg':
        this.stats.unsupportedCalls += 1;
        throw officialError(OFFICIAL_CODE.unsupportedForward, '官方通道不支持合并转发发送');
      case 'get_forward_msg':
        this.stats.unsupportedCalls += 1;
        throw officialError(OFFICIAL_CODE.unsupportedBackend,
          '官方通道没有历史消息回查接口；聊天记录在入站时已当场拍平成文本');
      case 'get_group_member_info':
      case 'get_group_member_list':
      case 'get_friend_list':
      case 'get_stranger_info':
        this.stats.unsupportedCalls += 1;
        throw officialError(OFFICIAL_CODE.unsupportedBackend,
          '官方通道的成员/好友接口是内邀白名单（11253），当前应用没有该权限');
      case 'get_msg':
      case 'get_image':
      case 'get_record':
        this.stats.unsupportedCalls += 1;
        throw officialError(OFFICIAL_CODE.unsupportedBackend, '官方通道没有按消息号回查的接口');
      case 'set_input_status':
        this.stats.unsupportedCalls += 1;
        throw officialError(OFFICIAL_CODE.unsupportedBackend,
          '官方通道的"输入中"要单独占一次消息，本批不接（省配额，也避免误发）');
      case 'set_group_ban':
      case 'delete_group_member':
      case 'set_friend_add_request':
        this.stats.unsupportedCalls += 1;
        throw officialError(OFFICIAL_CODE.unsupportedBackend, '官方通道不支持该群管/好友动作');
      default:
        this.stats.unsupportedCalls += 1;
        throw officialError(OFFICIAL_CODE.unsupportedBackend, `官方通道不支持动作 ${action}`);
    }
  }

  /**
   * 绑定表：**优先读运行时的配置**（面板刚写完就能立刻生效，不用重启），
   * 没有注入 `getCfg` 时回落到构造时那份（测试与一次性调用）。
   *
   * ⚠️ 只有群绑定。主人不住这里 —— 主人的唯一真值是 `owner.qq`（大脑与叫醒路都读它），
   *    在这里再存一份就会出现"面板说设过主人了、而它仍然不认你"。
   *    这里只读不算：openid → 本地群号的映射规则只住在 `#resolveGroupId` /
   *    `#resolveGroupSendTarget` 一处。
   */
  #bindings() {
    const live = this.getCfg ? this.getCfg()?.channel?.bindings : null;
    const b = live && typeof live === 'object' ? live : (this.initialBindings || {});
    return { groups: b.groups && typeof b.groups === 'object' ? b.groups : {} };
  }

  /** 入站：openid → 本地群号（没绑定就原样返回 openid）。 */
  #resolveGroupId(openid) {
    return localIdOfGroup(this.#bindings().groups, openid);
  }

  /** 出站：本地群号或 openid → group_openid；认不出来返回空串（调用方必须明确失败）。 */
  #resolveGroupSendTarget(id) {
    return openidOfGroup(this.#bindings().groups, id);
  }

  #groupList() {
    const groups = this.#bindings().groups;
    const out = [];
    for (const [openid, value] of Object.entries(groups)) {
      const localId = String(value?.localId ?? '').trim() || openid;
      const seen = this.pendingGroups.get(openid) || {};
      out.push({
        group_id: /^\d+$/.test(localId) ? Number(localId) : localId,
        group_name: String(value?.name || seen.name || ''),
        group_openid: openid,
        member_count: Number(seen.memberCount) || 0,
      });
    }
    return out;
  }

  // ── 可观测面 ────────────────────────────────────────────────────────────
  healthSnapshot() {
    const g = this.gateway.snapshot();
    return {
      channel: 'official',
      configured: this.configured,
      connected: this.connected,
      selfId: this.selfId,
      selfName: this.selfName,
      appId: this.appId,
      connectedAt: this.connectedAt,
      lastFrameAt: this.lastFrameAt,
      lastSendAt: this.lastSendAt,
      lastHeartbeatAt: g.lastAckAt,
      heartbeatIntervalMs: g.heartbeatIntervalMs,
      botOffline: this.botOffline,
      botOfflineAt: this.botOfflineAt,
      reconnects: g.reconnects,
      watchdogKills: g.watchdogKills,
      lastDropReason: g.lastDropReason,
      lastStatusAt: g.readyAt,
      lastStatusOk: this.connected,
      lastError: this.lastError,
      lastErrorCode: this.lastErrorCode,
      stats: { ...this.stats },
      gateway: g,
      token: this.tokens.snapshot(),
      passive: this.passive.snapshot(),
      seen: this.seen.snapshot(),
      pendingGroups: [...this.pendingGroups.values()].slice(-20),
      pendingMembers: [...this.pendingMembers.values()].slice(-20),
      // 对象而不是 [入口数组]：面板按 `recvAll[群 openid]` 直接查，
      // 发成 pair 数组的话页面得自己再拼一次 Map（两份形状必然漂）。
      recvAll: Object.fromEntries(this.recvAll.entries()),
      groupsBound: Object.keys(this.#bindings().groups).length,
    };
  }
}
