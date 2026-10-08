#!/usr/bin/env node
/**
 * 配置脱敏器 —— **唯一一份**「哪些字段算敏感」的规则（B9 · K-SANDBOX）。
 *
 * 为什么必须只有一份：它有两个消费者，
 *   ① `scripts/make-config-example.mjs` —— 从真机 config.json 生成 config.example.json；
 *   ② `test/sandbox.sh`                  —— 喂给沙箱的配置副本。
 * 两边各写一套的话，迟早出现「example 抹干净了、沙箱副本漏了一个」这种
 * **看代码看不出来**的差别 —— 而沙箱副本是会躺进 `/tmp` 的（正是 B9 要修的洞）。
 *
 * ────────────────────────────────────────────────────────────────────────
 *  B9 修掉的三处旧缺陷（它们当时已经在 config.example.json 里生效了）
 * ────────────────────────────────────────────────────────────────────────
 *  旧规则是 `/(key|token|secret|password)/i` —— **不锚定**，于是：
 *   ① `llm.maxTokens`（值 400）被当成凭据抹成 `""`，`presets.*.maxTokens` 同样中招。
 *      它是**有效配置**，不是死字段；模板里那个值悄悄变成空串，等于给出一份坏模板。
 *   ② `llm.keys` 是一个**对象**（`{zhipu:…, deepseek:…}`），被整份抹成 `""` ——
 *      **形状被破坏**，照模板写出来的配置会让"切服务商自动换 Key"整条链失效。
 *  两类错误都不报错，只是让产物静默地变得不可用。所以现在：
 *   · 凭据判定**结尾锚定**（`maxTokens` 结尾是 `okens`，不匹配；`apiKey` 结尾是 `Key`，匹配）；
 *   · 值是对象/数组时**继续往里走**，只处理叶子上的字符串，绝不改形状。
 *
 * CLI：
 *   node scripts/sanitize-config.mjs --in <真机config.json> --out <目标> [--blank-groups]
 *         [--credentials blank|fake]
 *   node scripts/sanitize-config.mjs --self-check --in <文件>
 *
 * `--credentials blank`（默认）把凭据清成空串 —— 给**模板**用（空 = "这里该填"）。
 * `--credentials fake` 换成一眼可辨的假值 —— 给**沙箱**用：测试要跑完整路径，
 * 凭据为空会让"切换服务商自动换 Key"这类断言全部失去意义（实测：会掉 3 条断言）。
 *
 * 退出码：0 成功；非 0 = 脱敏失败或自检不过 —— **绝不静默继续**。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 服务商判定只有一份实现（B11c · AR-DATADRIVEN）—— 这里只读它的输出给假值起名。
import { providerOf } from '../src/net-rules.js';

/**
 * 命中的键名视为凭据。**结尾锚定**是刻意的：
 *   `apiKey` / `keys` / `accessToken` / `secret` / `password` ✓
 *   `maxTokens`（结尾 `okens`）✗ —— 它是数值配置，不是凭据
 *   `apiKeyEnv`（结尾 `Env`）✗ —— 那是环境变量的**名字**，本身不是秘密
 */
const CREDENTIAL_KEY = /(?:key|keys|token|secret|password|passwd|pwd)$/i;

/** 一看就是本工具造出来的假凭据，自检时不算泄漏（真 Key 不会以它开头） */
export const FAKE_CREDENTIAL_PREFIX = 'SANDBOX-FAKE-';

/**
 * 这些数组里装的是个人信息（群号 / QQ 号）：example 需要清空、沙箱不必。
 *
 * `qq` 是 D31-2 加的（`config.owner.qq` —— 谁有权把它从睡眠里叫醒）。
 * 它是**先加的规则、后填的值**：现在真机上那一节还是空数组，但一旦有人填进去，
 * 下一次生成 `config.example.json` 就会把主人的 QQ 号写进仓库 ——
 * 而模板是**会随仓库发布**的文件（PUBLISH-CHECKLIST 里点过一次名）。
 * 所以这条必须在"值还没填"的时候就位：漏掉它的表现不是报错，是悄悄 publish 一个号。
 */
const PRIVATE_LISTS = new Set(['groups', 'private', 'users', 'qq']);

/**
 * 已确认的死字段：代码里只写不读（2026-09-17 清理时从 server.js 删掉了写入处）。
 * 真实 config.json 里可能还残留着，生成 example 时在这里剔除 ——
 * 不然每次重新生成又会把垃圾键带回来。
 */
const DROP_KEYS = new Set([
  'cloudBaseUrl', 'cloudModel', 'cloudMaxTokens', 'cloudContext', 'cloudFallbackModels', 'activeProvider',
]);

/** 这个键名本身就是一个「凭据容器」（如 `llm.keys`），它的叶子全是凭据 */
const CREDENTIAL_CONTAINER = 'keys';

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/**
 * 给假值起名用的「当前大脑」推断。
 *
 * ⚠️ 它**不参与任何业务判定**，只决定假值长什么样（`SANDBOX-FAKE-zhipu`）。
 *    真正的服务商判定只有一份实现（`src/net-rules.js`），这里**读它的输出** ——
 *    以前这里自带一份 `/bigmodel\.cn/` + `/deepseek\.com/` 的拷贝，是"五份拷贝"里
 *    最不容易被发现的那一份（注释还写着"不是又抄了一份判定规则"，实际就是抄了）。
 *
 * 为什么必须让 `llm.apiKey` 跟"当前那家"一致（实测踩出来的）：
 *   切大脑时 `stashCurrentPreset` 会把**当前的 apiKey** 归档进 `keys[当前家]`。
 *   如果造出来的 apiKey 名不副实（比如统一叫 `apiKey`），那么第一次切换就会
 *   把 `keys.zhipu` 里正确的假值**覆盖**掉，之后切回智谱拿到的就是那个错的值
 *   （实测：`apiKey` 一路都是 `SANDBOX-FAKE-apiKey`，一条断言因此挂掉）。
 *   真机上不存在这个问题 —— apiKey 本来就是当前那家的真 Key，归档等于原样写回。
 *   换句话说：**脱敏产物必须保持配置自身的自洽性**，否则测出来的是脱敏器的 bug。
 */
function activeProviderHint(cfg) {
  // 只给云端几家起名：本机与"未知服务商"都返回空（保持原行为 —— 原来也是 `''`）。
  //
  // ⚠️ 2026-10-07 加了 `qwen`。漏加的症状与上面那段注释里写的是**同一个**：
  //    沙箱里切到千问时 `llm.apiKey` 会被造名成 `SANDBOX-FAKE-apiKey`，
  //    而第一次切换又把它归档进 `keys.qwen` ⇒ 覆盖掉那一格本来正确的假值 ⇒
  //    "切走再切回来 Key 变了"这条断言会**莫名其妙地挂**，而它挂的原因是脱敏器。
  //    （判据一句话：**凡是能当"当前大脑"的服务商，都要在这里有一格。**）
  const p = providerOf(cfg?.llm?.baseUrl);
  return p === 'deepseek' || p === 'zhipu' || p === 'qwen' ? p : '';
}

/**
 * 一个凭据该被换成什么。
 * @param {'blank'|'fake'} mode
 * @param {string} leaf   当前键名（例如 `apiKey` / `zhipu`）
 * @param {string} parent 父键名（例如 `llm` / `keys` / `zhipu`）
 * @param {string} activeHint 当前大脑（仅用于给 `llm.apiKey` 起名，见上）
 */
function credentialValue(mode, leaf, parent, activeHint = '') {
  if (mode !== 'fake') return '';
  // `llm.keys.zhipu` → `zhipu`；`presets.zhipu.apiKey` → `zhipu`；`llm.apiKey` → 当前家。
  // 全都换成同一个假值的话，"切到另一家后 Key 换成了另一把"这条断言就变成永远成立的空断言。
  let hint = parent && parent !== 'llm' && parent !== CREDENTIAL_CONTAINER ? parent : leaf;
  if (parent === 'llm' && activeHint) hint = activeHint;
  return `${FAKE_CREDENTIAL_PREFIX}${hint}`;
}

/**
 * 深拷贝一份并脱敏；返回新对象，不改动入参。
 * @param {object} cfg
 * @param {{ blankGroups?: boolean, dropDeadKeys?: boolean, credentials?: 'blank'|'fake' }} [opt]
 */
export function sanitizeConfig(cfg, { blankGroups = false, dropDeadKeys = false, credentials = 'blank' } = {}) {
  // 当前大脑只用来给 `llm.apiKey` 起假名，见 activeProviderHint 的注释
  const activeHint = activeProviderHint(cfg);
  const walk = (node, parent) => {
    if (Array.isArray(node)) return node.map((x) => walk(x, parent));
    if (isObj(node)) {
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        // DROP_KEYS 先判：死字段应当**剔除**，而不是被当成凭据置空（那会留下一个空键）
        if (dropDeadKeys && DROP_KEYS.has(k)) continue;
        const isCred = CREDENTIAL_KEY.test(k) || parent === CREDENTIAL_CONTAINER;
        if (isCred && !isObj(v) && !Array.isArray(v)) {
          out[k] = credentialValue(credentials, k, parent, activeHint);
        } else if (isCred && isObj(v)) {
          // 凭据**容器**（如 llm.keys）：形状要保住，只把里面的叶子换掉。
          // 旧实现直接把它抹成 ''，等于产出一份坏配置。
          out[k] = walk(v, CREDENTIAL_CONTAINER);
        } else if (blankGroups && PRIVATE_LISTS.has(k) && Array.isArray(v)) {
          out[k] = [];
        } else {
          out[k] = walk(v, k);
        }
      }
      return out;
    }
    return node;
  };
  return walk(cfg, '');
}

/**
 * 自检：脱敏后的配置里**不允许**再出现任何"看起来像真凭据"的值。
 *
 * 这是本文件存在的主要理由 —— 脱敏逻辑写错了（漏一个键、正则写反）不会报任何错，
 * 只会安安静静把真 Key 抄一份出去。所以每次都必须**回读核对**。
 *
 * @returns {string[]} 违规路径列表，空数组 = 干净
 */
export function findLeaks(cfg) {
  const bad = [];
  const walk = (node, parent, trail) => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, parent, `${trail}[${i}]`));
      return;
    }
    if (!isObj(node)) return;
    for (const [k, v] of Object.entries(node)) {
      const here = trail ? `${trail}.${k}` : k;
      const isCred = CREDENTIAL_KEY.test(k) || parent === CREDENTIAL_CONTAINER;
      if (isCred && !isObj(v) && !Array.isArray(v)) {
        const clean = v === '' || v === null || v === undefined || String(v).startsWith(FAKE_CREDENTIAL_PREFIX);
        if (!clean) bad.push(`${here} = ${JSON.stringify(String(v)).slice(0, 12)}…`);
      } else if (isCred && isObj(v)) {
        // 容器本身不是"值"，继续往下看它的叶子；但如果它**不是对象**（比如被写成了 ''），
        // 上面那一支已经报出来了 —— 这里只处理形状仍正确的容器。
        walk(v, CREDENTIAL_CONTAINER, here);
      } else {
        walk(v, k, here);
      }
    }
  };
  walk(cfg, '', '');
  return bad;
}

// ────────────────────────── CLI ──────────────────────────
function argOf(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : '';
}

// ⚠️ 用 realpath 比对（2026-09-29 · 外包任务2 v1 实测的真缺陷）：`path.resolve` 是纯字面处理 ——
//    在**符号链接路径**下（macOS 的 /tmp → /private/tmp 是最常见的一例）argv[1] 与
//    import.meta.url 的字面形式不同，CLI 分支会被**静默跳过**（exit 0、无输出、什么都不写）。
//    调用方（sandbox.sh）看到退出码 0 就以为脱敏做完了 —— 一次典型的「失败伪装成成功」，
//    后果是整个沙箱在没有配置的状态下跑（presets 崩、panel 出一串莫名其妙的红）。
const invokedDirectly = process.argv[1] && (() => {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url); }
})();

if (invokedDirectly) {
  const inFile = argOf('--in');
  const outFile = argOf('--out');
  const selfCheck = process.argv.includes('--self-check');
  const modeArg = argOf('--credentials');
  const credentials = modeArg === 'fake' ? 'fake' : 'blank';

  if (!inFile) {
    console.error('用法：--in <config.json> [--out <目标>] [--blank-groups] [--credentials blank|fake] [--self-check]');
    process.exit(2);
  }
  if (modeArg && modeArg !== 'blank' && modeArg !== 'fake') {
    console.error(`✗ --credentials 只接受 blank / fake，收到 ${modeArg}`);
    process.exit(2);
  }

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(inFile, 'utf8'));
  } catch (e) {
    console.error(`✗ 读不了/解析不了 ${inFile}: ${e.message}`);
    process.exit(2);
  }

  if (selfCheck) {
    const leaks = findLeaks(cfg);
    if (leaks.length) {
      console.error(`✗ 自检不通过：${inFile} 里仍有 ${leaks.length} 处非空凭据`);
      for (const l of leaks) console.error(`    ${l}`);
      process.exit(1);
    }
    console.log(`✓ 自检通过：${inFile} 里没有任何非空凭据`);
    process.exit(0);
  }

  const clean = sanitizeConfig(cfg, {
    blankGroups: process.argv.includes('--blank-groups'),
    dropDeadKeys: true,
    credentials,
  });

  // 写出去之前先自检 —— 顺序不能反：先落盘再检查的话，
  // 中间那一瞬间真 Key 已经在磁盘上了（沙箱副本正好是这个路径）。
  const leaks = findLeaks(clean);
  if (leaks.length) {
    console.error(`✗ 脱敏后自检不通过，拒绝写出：${leaks.join('；')}`);
    process.exit(1);
  }

  if (outFile) {
    fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(clean, null, 2) + '\n');
    console.log(`✓ 已写出脱敏配置 → ${outFile}（凭据模式 ${credentials}；自检通过）`);
  } else {
    process.stdout.write(JSON.stringify(clean, null, 2) + '\n');
  }
}
