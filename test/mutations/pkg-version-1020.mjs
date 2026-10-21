/**
 * M-08c（版本号一致性 · 2026-10-20）的变异清单 —— 纯数据。
 *
 * 为什么补这条：`check-wb` 的 M-08 原先只比 `name`、不比 `version`，
 * 于是 `package.json` 已 0.1.3、`package-lock.json` 停在 0.1.2 **永远不红**。
 * 这条盲区能长期存活，正因为"没有任何判据读那两个字段"。
 *
 * 跑法：`NODE_OPTIONS= node scripts/mutate.mjs test/mutations/pkg-version-1020.mjs`
 */

export default [
  {
    id: 'V1',
    note: '把 `package-lock.json` 的顶层版本改成一个与 package.json 不同的值（0.1.2）'
      + ' —— M-08c 必须变红（这正是 2026-10-20 之前的真实状态；此前它绿了两周多）。预期 BLOCKED',
    file: 'package-lock.json',
    /* 版本号每次发版都会变，锚点不能写死某一版（0.1.3 的旧锚点在 0.1.4 发版时
       直接失效，两条变异变成 INVALID）。用 \d+\.\d+\.\d+ 匹配当前版本，
       apply 再换成一个**与 package.json 不同**的值。 */
    anchor: /"version": "\d+\.\d+\.\d+",\n  "lockfileVersion"/,
    count: 1,
    apply: (s) => s.replace(/("version": ")\d+\.\d+\.\d+(",\n  "lockfileVersion")/, '$1' + '0.1.2' + '$2'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'V2',
    note: '只改 `packages[""].version`、顶层保持正确 —— M-08c 必须变红'
      + '（"只修一处"是最常见的半修形态：肉眼看着对，另一处还在漂）。预期 BLOCKED',
    file: 'package-lock.json',
    anchor: /"": \{\n      "name": "ai-bot-groupmate",\n      "version": "\d+\.\d+\.\d+"/,
    count: 1,
    apply: (s) => s.replace(/("": \{\n      "name": "ai-bot-groupmate",\n      "version": ")\d+\.\d+\.\d+(")/, '$1' + '0.1.2' + '$2'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
