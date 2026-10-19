/**
 * NapCat「启动器长什么样」的**唯一形状判据**（P6 · 2026-10-18 从 common.mjs 搬出来）。
 *
 * 为什么单独一个零依赖叶子：这个判据有三个消费者，但其中两个隔着载荷根
 * （安装器 tools/ 与 app/panel/ 在装机后是两个不同目录，后者还每次升级换路径），
 * 合并不了；能合并的这两份（`lib/common.mjs` 与构建脚本 `make-vm-copy.mjs`）
 * 必须共用同一张表 —— 否则"官方又改了启动器名字"这件事会出现一处认得、一处认不得。
 *
 * ⚠️ 本文件**零依赖**：不许 import 任何会解析路径根的东西。make-vm-copy.mjs 是
 *    Mac 上的构建脚本，它要能在没有安装布局的环境里判断一个目录像不像协议端。
 *
 * 来历（这段历史就是为什么它是一张表而不是一个正则）：
 *   · 最初只有一条宽松正则 `/^napcat[\w-]*\.(bat|exe)$/i`，理由是"名字改过多次"。
 *     实测（NapCat.Shell.Windows.OneKey.zip v4.18.33）发现它**同时**匹配了
 *     `NapCatInstaller.exe` —— 那是**安装器**，不是启动器。宽松到一定程度
 *     就不再是"容错"，而是"指错"。⇒ ① 精确候选 + 优先级；② 明确排除安装/结束一类；
 *     ③ 兜底才用宽泛匹配。
 *   · 同一优先级里必须挑得确定：`launcher*.bat` 会同时命中 launcher.bat /
 *     launcher-user.bat / launcher-win10.bat，而除 `*-user` 外那几个开头会做
 *     `net session` 管理员检查，非管理员时另开提权窗口再 exit ⇒ 用户看到的
 *     就是"双击了没反应 / 二维码跑到别的窗口去了"。所以固定优先 `*-user`。
 */

/** 启动器候选，**按优先级排**（数组顺序就是优先级）。 */
export const NAPCAT_LAUNCHER_CANDIDATES = [
  /^launcher[\w-]*\.bat$/i,     // 官方文档里最常见的一任名字
  /^NapCatWinBootMain\.exe$/i,  // Windows 一键包里的真正入口
  /^napcat\.bat$/i,
  /^napcat[\w.-]*\.bat$/i,      // napcat.quick.bat 之类
];

/** 名字里带这些的**不是**启动器（安装器、结束器、卸载器）。 */
export const NOT_LAUNCHER_RE = /(install|uninstall|kill|stop|remove)/i;

/** 粗判"这个名字像不像启动器"（不排序、不选优先级，只做形状判断）。 */
export function isNapcatLauncherName(name) {
  const n = String(name || '');
  if (NOT_LAUNCHER_RE.test(n)) return false;
  return /\.(bat|exe|cmd)$/i.test(n) && NAPCAT_LAUNCHER_CANDIDATES.some((re) => re.test(n));
}
