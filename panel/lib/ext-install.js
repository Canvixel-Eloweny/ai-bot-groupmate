/**
 * 扩展包 ZIP 安装 —— **staging + 备份 + 回滚**（D21 · 报告 E16）。
 * ══════════════════════════════════════════════════════════════════════════
 *  它要回答的问题
 * ══════════════════════════════════════════════════════════════════════════
 *  用户从别处拿到一个扩展包 ZIP，想装进来。做这件事之前必须先把三件说清：
 *    · **这个包合不合法**（路径穿越 / 符号链接 / 体积 / 清单）—— 见 `planInstall`；
 *    · **装进去会不会把已有的同名包弄坏**（备份 → 替换 → 失败回滚）；
 *    · **装完会不会自动生效**（不会：装只写目录，启用仍由用户在面板上勾）。
 *
 * ⚠️ 层号：L1。它 import 的 `src/` 模块只有 **零依赖叶子** `plugin-manifest.js`
 *    （纯字符串判据，不碰 fs）与 `atomic-write.js`（临时文件命名形状的唯一来源）。
 *
 * ⚠️ **IO 全部可注入**（`io` 入参）—— 于是"写第二个文件时失败"这种只在磁盘满时
 *    才会真实发生的情况，能在测试里被确定性地制造出来，从而真的验证回滚。
 *    这是"判据层 IO 全入参"那条纪律在**多步落盘**上的形态。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  isSafeRelPath, isValidPluginId, normalizeManifest, stripBom, MANIFEST_FILES,
} from '../../src/plugin-manifest.js';
import { tmpPathOf } from '../../src/atomic-write.js';
import { readZip } from './zip.js';

/**
 * 打包工具塞进来的垃圾条目 —— **显式忽略**，且只忽略这几种。
 *
 * 为什么需要：macOS 的"压缩"会给每个包塞一个 `__MACOSX/` 旁目录与若干 `.DS_Store`。
 * 不忽略它们的话，「顶层目录必须恰好一个」这条判据会把**每一个 Mac 打的包**都拒掉
 * （而用户看到的是"这个 ZIP 里不是一个包"，完全猜不到是 Finder 加的东西）。
 * ⚠️ 忽略名单是**封闭的**：不肯为"看起来像垃圾"的任意条目开口子（那会让判据失效）。
 */
function isIgnorableEntry(name) {
  const n = String(name ?? '');
  if (!n) return true;
  if (n.startsWith('__MACOSX/')) return true;
  return n.split(/[\\/]/).some((seg) => seg === '.DS_Store' || seg === 'Thumbs.db');
}

/**
 * 只做**判据**：给定条目与两个根，判断"这个包能不能装、装到哪、装成什么 id"。
 * 纯函数（不碰 IO）—— 于是它能在测试里被逐格喂反例。
 *
 * @param {Array<{name:string, data:Buffer, dir:boolean, link:boolean}>} entries
 * @param {{roots:Array<{dir:string, kind:string, name:string}>}} opts
 * @returns {{ok:true, root:object, kind:string, id:string, pkgDir:string,
 *            files:Array<{rel:string, data:Buffer}>, manifest:object}
 *          | {ok:false, error:string}}
 */
export function planInstall(entries, { roots = [], expectedKind = null } = {}) {
  const usable = (Array.isArray(entries) ? entries : []).filter((e) => !isIgnorableEntry(e?.name));
  const files0 = usable.filter((e) => !e.dir);
  if (!files0.length) return { ok: false, error: '这个 ZIP 里没有文件' };

  // ① 路径安全：整包任一条不过就**整包拒绝** —— 半个包比拒绝更坏
  //    （"装上了但少几个文件"没有任何地方看得出来）。
  //    判据复用 `src/plugin-manifest.js` 的 `isSafeRelPath`（唯一实现，禁自写 `..` 判据）。
  for (const e of files0) {
    if (e.link) return { ok: false, error: `「${e.name}」是符号链接 —— 扩展包里不允许符号链接` };
    if (!isSafeRelPath(e.name)) return { ok: false, error: `「${e.name}」不是安全的相对路径` };
  }

  // ② 顶层形状：恰好一个包根目录。
  const tops = [...new Set(files0.map((e) => e.name.split(/[\\/]/)[0]))];
  if (tops.length > 1) {
    return { ok: false, error: `这个 ZIP 里有多个顶层目录（${tops.slice(0, 4).join('、')}）—— 请把单个扩展包目录打成一个 ZIP` };
  }
  const pkgDir = tops[0];
  // ⚠️ 目录名**不要求英文**（2026-09-29 量数推翻第一版）：真实生态里目录名全是中文
  //    （`复读拦截` / `定时文案推送`…），英文那个是清单里的 `id`。
  //    第一版拿 `isValidPluginId(pkgDir)` 当判据 → **会把所有真实扩展包拒掉**。
  //    目录名只需"安全的相对路径"这一点（上面已逐条校验过）。
  if (!pkgDir || pkgDir.length > 80) {
    return { ok: false, error: `顶层目录名「${pkgDir}」不可用（空或过长）` };
  }

  const files = [];
  for (const e of files0) {
    const rel = e.name.split(/[\\/]/).slice(1).join('/');
    if (!rel) return { ok: false, error: `「${e.name}」是包根下的文件 —— 扩展包必须整个装在一个目录里` };
    files.push({ rel, data: e.data });
  }

  // ③ 清单：按既有优先序取第一份存在的，用它决定 kind 与目标根。
  // 双清单（skill.json + plugin.json 同时存在）在安装口一律拒绝：加载器可以取优先序，
  // 但安装时“这份 ZIP 到底算哪一档”不能靠猜；页面上的 kind 就是用户的意图。
  const manifestHits = MANIFEST_FILES
    .map((mf) => files.find((f) => f.rel === mf))
    .filter(Boolean);
  if (manifestHits.length > 1) {
    return { ok: false, error: `包里同时有 ${MANIFEST_FILES.join(' 与 ')} —— 请只保留一份清单，再重新打包` };
  }
  let kind = '';
  let raw = null;
  let badJson = '';
  const hit = manifestHits[0];
  if (hit) {
    kind = hit.rel === MANIFEST_FILES[0] ? 'skill' : 'plugin';
    try {
      raw = JSON.parse(stripBom(String(hit.data.toString('utf8'))));
    } catch (e) {
      badJson = e?.message ?? String(e);
    }
  }
  if (!kind) return { ok: false, error: `包里没有 ${MANIFEST_FILES.join(' / ')} —— 这不是一个扩展包` };
  if (badJson) return { ok: false, error: `${kind === 'skill' ? 'skill.json' : 'plugin.json'} 不是合法 JSON：${badJson}` };
  if (expectedKind && kind !== expectedKind) {
    const want = expectedKind === 'skill' ? 'Skill' : '插件';
    const got = kind === 'skill' ? 'Skill' : '插件';
    return { ok: false, error: `${want}页只接受${want}包，这个 ZIP 是${got}包（清单为 ${hit.rel}）—— 请到对应页面安装` };
  }
  if (kind === 'skill' && !files.some((f) => f.rel === 'index.js')) {
    return { ok: false, error: 'Skill 包缺少 index.js —— 纯提示词 Skill 也需要入口文件，内容写 export {} 即可' };
  }

  const root = (Array.isArray(roots) ? roots : []).find((r) => r?.kind === kind);
  if (!root?.dir) return { ok: false, error: `找不到 ${kind} 的安装目录` };

  // ④ 清单结构：复用既有的归一化（apiVersion 闸 / 字段校验都在里面）。
  const norm = normalizeManifest(raw, { fallbackId: pkgDir, kind });
  if (norm.fatal?.length) {
    return { ok: false, error: `清单不合法：${norm.fatal.map(textOf).join('；')}` };
  }
  const id = String(norm.manifest?.id || pkgDir);
  // id 必须是英文：它会变成 `custom.plugins.enabled` 的键与日志前缀（`isValidPluginId` 的既有约定）。
  // ⚠️ 这一条与"目录名可以是中文"并不矛盾 —— 真实的包都是"中文目录名 + 英文 id"。
  if (!isValidPluginId(id)) {
    return { ok: false, error: `清单里的 id「${id}」不合法：必须英文、字母开头、≤40 位（它会成为启用名单的键）` };
  }

  return { ok: true, root, kind, id, pkgDir, files, manifest: norm.manifest };
}

/** 默认真 IO（可被入参替换 —— 测试用假 IO 才能确定性地制造"写到一半失败"） */
const REAL_IO = {
  existsSync: fs.existsSync,
  lstatSync: fs.lstatSync,
  statSync: fs.statSync,
  realpathSync: fs.realpathSync,
  mkdirSync: fs.mkdirSync,
  renameSync: fs.renameSync,
  writeFileSync: fs.writeFileSync,
  rmSync: fs.rmSync,
};

/** 把错误折成一行可读文案。本项目一律不把底层异常原样抛给用户。 */
const msgOf = (e) => String(e?.message ?? e ?? '未知错误');

/**
 * `normalizeManifest` 的 `fatal` / `problems` 是**结构化条目**（`{code, text}`），
 * 不是字符串 —— 直接 join 会得到一串 `[object Object]`（第一版就这么错，量数当场抓到）。
 * 三种形态都兜住：字符串 / `{text}` / `{code}`，最后才退回 JSON。
 */
const textOf = (w) => String(
  typeof w === 'string' ? w : (w?.text || w?.code || JSON.stringify(w))
);

/**
 * 装一个 ZIP。**三步**：备份 → 原子替换 → 提交；任一步失败都回到原样。
 *
 * @param {{bytes:Buffer, roots:Array<object>, overwrite?:boolean, io?:object,
 *          expectedKind?:string|null, expectedId?:string}} o
 * @returns {{ok:true, id:string, kind:string, dir:string, root:string, files:number, replaced:boolean}
 *          | {ok:false, code:number, error:string}}
 */
export function installArchive({
  bytes, roots = [], overwrite = false, io = REAL_IO, expectedKind = null, expectedId = '',
} = {}) {
  const z = readZip(bytes);
  if (!z.ok) return { ok: false, code: 400, error: z.error };

  const plan = planInstall(z.entries, { roots, expectedKind });
  if (!plan.ok) return { ok: false, code: 400, error: plan.error };

  // 更新场景：页面已经点名了要覆盖的包 id，就不允许“选错包”静默装成另一个。
  // 放在任何落盘之前 —— 拒绝时旧包一个字节都不动。
  const wantId = String(expectedId || '');
  if (wantId && plan.id !== wantId) {
    return {
      ok: false,
      code: 409,
      error: `这个包的 id 是「${plan.id}」，与要更新的「${wantId}」不一致 —— 已拒绝，旧包未改动`,
    };
  }

  const target = path.join(plan.root.dir, plan.pkgDir);
  const exists = io.existsSync(target);
  if (exists && !overwrite) {
    return { ok: false, code: 409, error: '同名包已存在（要覆盖请显式确认）' };
  }

  // 备份目录与目标**同根同级**（同一文件系统，rename 才是原子的），
  // 名字沿用 `atomic-write.js` 的临时文件形状 —— 那样**既有的清扫**才认得出它（D21 前提三处之一）。
  const backup = tmpPathOf(target);
  let hadBackup = false;
  try {
    io.mkdirSync(plan.root.dir, { recursive: true });
  } catch (e) {
    return { ok: false, code: 500, error: `安装目录不可写：${msgOf(e)}` };
  }

  if (exists) {
    try {
      io.renameSync(target, backup);
      hadBackup = true;
    } catch (e) {
      // 备份失败就**什么都不动**地退出 —— 目标仍是原来那一份。
      return { ok: false, code: 500, error: `备份已有包失败（目标未改动）：${msgOf(e)}` };
    }
  }

  try {
    io.mkdirSync(target, { recursive: true });
    for (const f of plan.files) {
      const dest = path.join(target, ...f.rel.split('/'));
      io.mkdirSync(path.dirname(dest), { recursive: true });
      io.writeFileSync(dest, f.data);
    }
  } catch (e) {
    // 回滚：先删掉半包，再把备份换回来。两步各自吞异常 —— 回滚失败不能掩盖原始错误。
    try { io.rmSync(target, { recursive: true, force: true }); } catch { /* 半包删不掉也要继续 */ }
    let rolled = false;
    if (hadBackup) {
      try { io.renameSync(backup, target); rolled = true; } catch { /* 见下 */ }
    }
    return {
      ok: false,
      code: 500,
      error: `写入失败${rolled ? '，已回滚到原包' : ''}：${msgOf(e)}`,
    };
  }

  if (hadBackup) {
    try { io.rmSync(backup, { recursive: true, force: true }); } catch { /* 备份删不掉只是留个垃圾，启动时清扫会收 */ }
  }

  return {
    ok: true,
    id: plan.id,
    kind: plan.kind,
    dir: plan.pkgDir,
    root: path.basename(plan.root.dir),
    files: plan.files.length,
    replaced: hadBackup,
  };
}

/**
 * 卸载前的**判据**：客户端只给 kind + id，目录名一律从服务端扫描结果取。
 * 这样即使有人伪造 `id`，也拿不到任意路径；目标必须真在扩展根下、
 * 不是符号链接、且含对应清单，才允许删。
 *
 * @param {{item:object, kind:string, roots:Array<object>, io?:object}} o
 * @returns {{ok:true, root:object, dirName:string, target:string}|{ok:false, error:string}}
 */
export function planRemove({ item, kind, roots = [], io = REAL_IO } = {}) {
  const k = kind === 'skill' ? 'skill' : kind === 'plugin' ? 'plugin' : '';
  if (!k) return { ok: false, error: '卸载类型只能是 plugin 或 skill' };
  const id = String(item?.id || '');
  if (!isValidPluginId(id)) return { ok: false, error: `扩展 id「${id}」不合法` };
  const dirName = String(item?.dirName || '');
  if (!dirName || dirName !== path.basename(dirName) || dirName === '.' || dirName === '..') {
    return { ok: false, error: '扩展目录名不安全，拒绝卸载' };
  }
  const root = (Array.isArray(roots) ? roots : []).find((r) => r?.kind === k);
  if (!root?.dir) return { ok: false, error: `找不到 ${k} 的安装目录` };
  const rootDir = path.resolve(root.dir);
  const target = path.join(rootDir, dirName);
  if (path.dirname(target) !== rootDir) return { ok: false, error: '目标不在扩展根下，拒绝卸载' };

  let st;
  try { st = io.lstatSync(target); } catch { return { ok: false, error: '扩展目录不存在（可能已经被删）' }; }
  if (typeof st.isSymbolicLink === 'function' && st.isSymbolicLink()) {
    return { ok: false, error: '扩展目录是符号链接，拒绝卸载' };
  }
  if (typeof st.isDirectory === 'function' && !st.isDirectory()) {
    return { ok: false, error: '扩展目标不是目录，拒绝卸载' };
  }

  let realRoot = '';
  let realTarget = '';
  try {
    realRoot = io.realpathSync(rootDir);
    realTarget = io.realpathSync(target);
  } catch (e) {
    return { ok: false, error: `无法解析扩展路径：${msgOf(e)}` };
  }
  if (realTarget !== path.join(realRoot, dirName)) {
    return { ok: false, error: '扩展目录解析后不在扩展根下，拒绝卸载' };
  }

  const manifest = k === 'skill' ? 'skill.json' : 'plugin.json';
  if (!io.existsSync(path.join(target, manifest))) {
    return { ok: false, error: `目标里没有 ${manifest}，不像一个 ${k === 'skill' ? 'Skill' : '插件'}包` };
  }
  return { ok: true, root, dirName, target };
}

/**
 * 真正删目录。配置清理在调用方先做 —— 这样删目录失败时启用名单已经不再指向它，
 * 用户看到的是「目录还在」而不是「配置还勾着一个不存在的包」。
 */
export function removeExtension({ target, io = REAL_IO } = {}) {
  if (!target) return { ok: false, error: '没有卸载目标' };
  try {
    io.rmSync(target, { recursive: true, force: false });
  } catch (e) {
    const code = String(e?.code || '');
    const hint = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
      ? '（目录可能正被机器人加载：先停止机器人或重启后再试）'
      : '';
    return { ok: false, error: `卸载目录失败${hint}：${msgOf(e)}` };
  }
  return { ok: true };
}

/**
 * 从 custom 配置里摘掉一个扩展的启用标记与设置。
 * 深拷贝后返回，调用方负责 writeConfig —— 判据与落盘分开，测试才能逐格喂反例。
 */
export function stripExtensionFromCustom(custom, kind, id) {
  const src = custom && typeof custom === 'object' ? custom : {};
  const c = JSON.parse(JSON.stringify(src));
  const ns = kind === 'skill' ? 'skills' : 'plugins';
  const ex = c.extensions && typeof c.extensions === 'object' ? c.extensions : null;
  if (ex) {
    if (Array.isArray(ex[ns]?.enabled)) ex[ns].enabled = ex[ns].enabled.filter((x) => x !== id);
    if (ex[ns]?.settings && typeof ex[ns].settings === 'object') delete ex[ns].settings[id];
  }
  // 旧面板写的派生别名：一份并集，删 id 对两类都成立。
  if (c.plugins && typeof c.plugins === 'object') {
    if (Array.isArray(c.plugins.enabled)) c.plugins.enabled = c.plugins.enabled.filter((x) => x !== id);
    if (c.plugins.settings && typeof c.plugins.settings === 'object') delete c.plugins.settings[id];
  }
  return c;
}
