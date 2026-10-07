/**
 * traceId 与「图片引用」（第 35 轮 B10a · O-TRACE / O-IMGURL）
 * ══════════════════════════════════════════════════════════════════════════
 *  traceId 解决什么
 * ══════════════════════════════════════════════════════════════════════════
 *  一条群消息从进来到发出，会经过「决策 → 限流 → 拼提示词 → 调模型 → 出口闸门 → 发送」，
 *  每一步都打一行日志。但这些日志**没有任何东西把它们串起来** ——
 *  排查"这条消息到底为什么没回"时，只能按时间戳去猜哪几行属于同一条。
 *  并发一来（两个群同时说话）就彻底分不清了。
 *
 *  traceId 就是这一条链路的把手：日志行带上它，对话流记录也带上它，
 *  于是「面板上那一条」和「bridge.log 里那几行」第一次可以对上。
 *
 *  刻意不引 OpenTelemetry SDK：这里要的只是一个全局唯一的短字符串，
 *  引一整套 SDK 换来的只是依赖和体积。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  图片引用为什么只留哈希
 * ══════════════════════════════════════════════════════════════════════════
 *  `parsed.images` 里是**图片 URL**。QQ 的图片地址常常带签名 / 临时 token，
 *  原样落盘等于把一次性凭据写进 `panel/local-trace.jsonl`（而那个文件会被面板读、
 *  会被沙箱 rsync）。所以只留一个 8 位短哈希：
 *  「这条带了几张图、是哪几张」仍然判得出来，但**拿不到可访问的地址**。
 */

import { randomBytes, createHash } from 'node:crypto';

/** 默认取 12 个十六进制字符：够短（日志里不刺眼）、也够唯一（48 位） */
export function newTraceId(rnd = () => randomBytes(6).toString('hex')) {
  const v = String(rnd());
  return v.length >= 12 ? v.slice(0, 12) : v.padEnd(12, '0');
}

/** 单个 URL → 8 位短哈希。不是安全用途，只是"这一张和那一张是不是同一张" */
export function imageHash(url) {
  return createHash('sha1').update(String(url)).digest('hex').slice(0, 8);
}

/**
 * 图片列表 → 引用列表。
 * 只输出 `{ h }`，**绝不输出 URL 本身**。数量照旧由调用方记 `imagesCount`。
 */
export function imageRefsOf(urls, hash = imageHash) {
  if (!Array.isArray(urls)) return [];
  return urls
    .filter((u) => typeof u === 'string' && u.length > 0)
    .map((u) => ({ h: hash(u) }));
}
