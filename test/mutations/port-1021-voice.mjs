/**
 * Win-v0.1.2 移植 · §127「峰谷 / 反模板 / 等待 / 图片」的定向变异（2026-10-21）。
 */
export default [
  {
    id: 'V1',
    note: '把峰谷门禁短路 —— §127 的「主链路 stage=peak」判据应红',
    file: 'src/index.js',
    anchor: /if \(peakReason\) \{/g,
    count: 1,
    apply: (s) => s.replace('if (peakReason) {', 'if (false) {'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'V2',
    note: '绕过反模板闸（不调用 deTemplate）—— §127 的反模板接线判据应红',
    file: 'src/index.js',
    anchor: /const tmpl = deTemplate\(recentOwn, parsedChunks\);/g,
    count: 1,
    apply: (s) => s.replace(
      'const tmpl = deTemplate(recentOwn, parsedChunks);',
      "const tmpl = { chunks: parsedChunks, hit: '', changed: false };"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'V3',
    note: '让私聊也走连发合并 —— §127 的「合并只群聊」判据应红（也会吞掉紧急唤醒计数）',
    file: 'src/index.js',
    anchor: /if \(evt\?\.message_type !== 'group'\) return enqueueFor\(evt\);/g,
    count: 1,
    apply: (s) => s.replace("if (evt?.message_type !== 'group') return enqueueFor(evt);", 'if (false) return enqueueFor(evt);'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'V4',
    note: '把图片本机路径的 realpath 防逃逸换成普通 resolve —— §127 的目录限制判据应红',
    file: 'src/index.js',
    anchor: /const realFile = fs\.realpathSync\(file\);/g,
    count: 1,
    apply: (s) => s.replace('const realFile = fs.realpathSync(file);', 'const realFile = path.resolve(file);'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
