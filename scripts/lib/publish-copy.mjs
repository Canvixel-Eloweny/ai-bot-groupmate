/**
 * 公开拷贝（对外发布副本）的**单一判定叶子**。
 *
 * 为什么要单独一片：`check-wb`、`mutate-lint`、`mutate`、`ci-verify` 都要回答
 * 「这是不是发布拷贝」「这个路径是不是按设计不发布」。此前只有 `check-wb` 里
 * 一段内联 IIFE，别处若照抄，就会长出第二份桩标记/排除名单 —— 本项目已因
 * 「同一语义两份拷贝」清过很多次。
 *
 * 判据来源不新造：`docs/` 白名单与顶层内部件都读 `./publish-docs.mjs`；
 * 这里只补上 `scripts/publish-audit.mjs` 这一条（它按设计持有真值哨兵表）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { isHeldBackDoc, isHeldBackRoot } from './publish-docs.mjs';

export const PUBLISH_COPY_MARKER = '对外拷贝里的**桩**';

/** 这个根是不是 `make-publish-copy.mjs` 生成的对外拷贝（按桩标记判）。 */
export function isPublishCopy(root) {
  try {
    return fs
      .readFileSync(path.join(root, 'docs', 'PUBLISH-CHECKLIST.md'), 'utf8')
      .includes(PUBLISH_COPY_MARKER);
  } catch {
    return false;
  }
}

/**
 * 发布拷贝里按设计**不存在**的路径（只用于门禁判断，不用于拷贝本身）。
 * `rel` 是仓库相对路径，统一折成正斜杠。
 */
export function isHeldBackForGates(rel) {
  const norm = String(rel || '').split(path.sep).join('/').replace(/^\.\//, '');
  if (!norm) return false;
  if (norm === 'scripts/publish-audit.mjs') return true;
  return isHeldBackDoc(norm) || isHeldBackRoot(norm);
}

/** 维护者本机（开发仓）才判的规则：有 `scripts/publish-audit.mjs` 即开发仓。 */
export function isMaintainerCheckout(root) {
  return fs.existsSync(path.join(root, 'scripts', 'publish-audit.mjs'));
}
