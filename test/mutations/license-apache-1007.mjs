/**
 * 许可迁移（AGPL-3.0 → Apache-2.0）+ 换仓（`ai-group-chat` → `ai-bot-groupmate`）的变异清单。
 * 2026-10-07 · 第 23 轮。
 *
 * 这一批打的全是「**repo 看起来完全正常、只有"这个仓库还能不能被合法使用"悄悄变了**」：
 * 代码照跑、测试照绿，而 LICENSE 被换掉、NOTICE 被清空、声明里的数字与磁盘脱钩，
 * 四层判据里**只有 check-wb 的「开源底座」那一段**看得见。
 *
 *   | 条  | 打的是                                            | 期望    | 原来会怎样 |
 *   |-----|---------------------------------------------------|---------|-----------|
 *   | M1  | LICENSE 换成 MIT 全文（短的、宽松的、看着更"干净"）| BLOCKED | 旧判据靠 ≥30000 字节判截断，改字符串后**照样通过** |
 *   | M2  | `package.json` 的 license 字段回退成 `AGPL-3.0-or-later` | BLOCKED | 两侧不一致，而没有任何东西比对它们 |
 *   | M3  | NOTICE 被清空                                      | BLOCKED | 删文件**没有任何报错**（它不在任何扫描面里） |
 *   | M4  | NOTICE 里没有版权行                                | BLOCKED | "署名通知没有署名" —— 一份像样的占位也比这好 |
 *   | M5  | 声明里的扩展包数量与磁盘脱钩（13 → 12）             | BLOCKED | **本轮真事故**：README 说 13、声明说 0，四层全绿 |
 *
 * ⚠️ **M1 与 M5 是本清单里最值钱的两条**：
 *   · M1 钉的是「**判据不能跟着字符串走**」—— Apache 全文 11,358 字节，比 AGPL 的 34,523 短得多，
 *     所以"最大长度下限"这种量尺在换许可的那一刻就失效了。现在判的是**双端特征句**。
 *   · M5 钉的是「**声明的数字必须来自实测**」—— 判据把数字从声明里读出来，再去 `git ls-files` 对。
 *     写死一个 13 的话，两边一起变仍然全绿（那正是这次漂移能活下来的原因）。
 *
 * ⚠️ 跑法（与别的清单同）：`NODE_OPTIONS= node scripts/mutate.mjs test/mutations/license-apache-1007.mjs`
 *    跑之前先确认工作树是干净的改动集（这一轮本身就在改这些文件，跑的时候**别同时编辑**）。
 */

export default [
  {
    id: 'M1',
    file: 'LICENSE',
    anchor: /Version 2\.0, January 2004/,
    count: 1,
    // 换成 MIT 全文的形状：短、宽松、"看着更干净" —— 而它确实是一种许可，不是垃圾数据
    apply: () => 'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\n'
      + 'of this software and associated documentation files (the "Software"), to deal\n'
      + 'in the Software without restriction.\n\nTHE SOFTWARE IS PROVIDED "AS IS".\n',
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '§25①：LICENSE 被换成别的许可（旧判据的 ≥30000 字节量尺在 Apache-2.0 下已失效）',
  },
  {
    id: 'M2',
    file: 'package.json',
    anchor: /"license": "Apache-2\.0"/,
    count: 1,
    apply: (src) => src.replace('"license": "Apache-2.0"', '"license": "AGPL-3.0-or-later"'),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '§25②：package.json 的 license 字段与 LICENSE 文件两侧不一致',
  },
  {
    id: 'M3',
    file: 'NOTICE',
    anchor: /Copyright 2026 Canvixel-Eloweny/,
    count: 1,
    apply: () => '',
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '§25①-2：NOTICE 被清空（删掉它不会有任何报错，README/声明先变死链）',
  },
  {
    id: 'M4',
    file: 'NOTICE',
    anchor: /Copyright 2026 Canvixel-Eloweny/,
    count: 1,
    apply: (src) => src.replace(/Copyright 2026 Canvixel-Eloweny/, 'Somebody, probably'),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '§25①-2：署名通知里没有 `Copyright <年份> <权利人>` 形状的行',
  },
  {
    id: 'M5',
    file: 'THIRD-PARTY-NOTICES.md',
    anchor: /随本仓库分发的扩展包\*\*共 13 个\*\*/,
    count: 1,
    apply: (src) => src.replace('随本仓库分发的扩展包**共 13 个**', '随本仓库分发的扩展包**共 12 个**'),
    layer: 'check-wb',
    expect: 'BLOCKED',
    note: '§25③-2：声明里的数量与 `git ls-files -- plugins skills` 脱钩（本轮真事故的形状）',
  },
];
