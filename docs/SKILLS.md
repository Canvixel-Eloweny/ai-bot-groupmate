# Skill 与插件：一套宿主，两种语义

> 这份文档写给**要写扩展包的人**，也写给**要改宿主的人**。
> 一句话结论：`plugins/` 与 `skills/` 共用同一个加载器、生命周期、工具表与开关；
> `kind` 只决定“这个包默认怎么被使用”，**不是两套 API，也不是沙箱**。

---

## 1. 两种 kind 的差别（只有这些）

| | 插件 `plugin` | Skill `skill` |
|---|---|---|
| 目录 | `plugins/<id>/` | `skills/<id>/` |
| 典型用途 | 确定性能力：钩子、拦截、固定时机必跑 | 给模型用的能力：注册工具 + 提示词指引 |
| 入口契约 | `setup` / `activate` / `hooks` 三者有其一 | 同上，**外加** `prompt.sections` 非空 |
| 纯提示词包 | 不支持（会被标 `no-entry-contract` 跳过） | 支持（`index.js` 写 `export {}` 即可） |
| 提示词注入段 | `extensions`（兼容指引） | `skillExt`（`## 你现在会用的 Skill`，2000 字预算） |
| 是否保证执行 | 钩子命中就必跑 | **不保证**：由模型判断是否调用工具 |
| 白名单 | `custom.extensions.plugins.enabled` | `custom.extensions.skills.enabled` |
| 设置 | `custom.extensions.plugins.settings.<id>` | `custom.extensions.skills.settings.<id>` |
| 控制台页 | 工厂 → 插件管理 | 工厂 → Skill |

两种 kind **共享**：

- 同一个 `ExtensionHost`（扫描 / 清单校验 / 白名单 / 四态生命周期 / 失败可见）；
- 同一张工具注册表与工具上限（`custom.tools.max`）；
- 同一个扩展总数上限（`custom.extensions.max`，两型合计）；
- 同一个钩子总线与单条超时（`custom.extensions.hookTimeoutMs`）；
- 同一套设置控件（敏感键、类型强转、越界拒绝）。

> ⚠️ `skills/` 目录里的代码扩展，与 `config.json` 里的 `custom.skills`（知识包 / 角色卡数据）
> **不是一回事**。前者是磁盘上的可执行包，后者是提示词数据。名字像，边界完全不同。

---

## 2. 最小包长什么样

### 2.1 纯提示词 Skill（不需要写逻辑）

`skills/group-etiquette/skill.json`

```json
{
  "id": "group-etiquette",
  "name": "群聊礼仪",
  "version": "1.0.0",
  "apiVersion": 1,
  "entry": "index.js",
  "prompt": {
    "sections": [
      {
        "id": "etiquette",
        "title": "群聊礼仪",
        "priority": 40,
        "content": "回答前先看最近几条消息，别重复别人刚说过的话。"
      }
    ]
  }
}
```

`skills/group-etiquette/index.js`

```js
export {};
```

要点：

- `index.js` **仍然必须有**（宿主按 `entry` 做入口预检）；内容可以是空的 `export {}`。
- `prompt.sections[].content` 会进入 `skillExt` 段；`title` 变成小标题。
- 超过 2000 字预算的段会被整段丢弃，面板预览会显示“丢弃段 N”。

### 2.2 注册工具的 Skill

```js
export function setup(api) {
  api.registerTool({
    id: 'roll_dice',
    description: '掷一个六面骰子',
    parameters: { type: 'object', properties: {} },
    execute: async () => String(1 + Math.floor(Math.random() * 6)),
  });
}
```

### 2.3 插件（确定性钩子）

```js
export const hooks = {
  // 钩子点全集见 src/hook-bus.js 的 HOOK_POINTS；未登记的名字会被拒绝并告警。
  // 这里演示 before-tool 的否决语义：返回 { block, reason } 即拦下这一次工具调用。
  'before-tool': async (ctx) => {
    if (ctx?.tool?.id === 'send_group_msg' && /广告/.test(JSON.stringify(ctx?.tool?.args || {}))) {
      return { block: true, reason: '群里不发广告' };
    }
    return undefined;
  },
};
```

钩子出错按 **fail-open** 放行并记账（与出口凭据闸门的 fail-closed 相反）——
一个写坏的扩展包不该让机器人彻底不说话。

### 2.4 混合型

Skill 导出 `hooks` 时**仍会加载**，但运行期标 `mixed`、面板显示“混合型（不推荐）”。
这不是错误，只是一个提醒：需要“条件满足必跑”的能力，应该做成插件。

---

## 3. 配置命名空间

```json
{
  "custom": {
    "extensions": {
      "plugins": { "enabled": ["my-plugin"], "settings": { "my-plugin": { "mode": "strict" } } },
      "skills":  { "enabled": ["group-etiquette"], "settings": {} },
      "max": 256,
      "hookTimeoutMs": 5000
    }
  }
}
```

- **旧配置兼容**：只有 `custom.plugins.enabled` / `settings` 的老配置会被派生成
  `custom.extensions.plugins` 与 `custom.extensions.skills` 两套同样的名单（旧语义本来就同时约束两个根）。
  读出来的 `custom.plugins` 是**派生别名**（两型并集），不要拿它当写入目标。
- **新写入**一律落 `custom.extensions.<plugins|skills>.*`；面板里 kind 是单数、命名空间是复数，
  换算只走 `panel/next/app.js` 的 `extNsOf()`。
- 改白名单**不支持热插拔**：保存后要重启机器人才加载。

---

## 4. 面板能看到什么

- **插件页**：静态扫描结果（可加载 / 未启用 / 有问题 / 超上限）、运行期状态、钩子/工具/空载徽标、
  每个包的设置控件。
- **Skill 页**：同样的卡片 + `提示词 N` 徽标（清单 `prompt.sections` 段数）、
  纯提示词/混合型标记、以及**模型可见预览**：
  - 运行期数据可用时显示“此刻注入”，并列出真实工具名；
  - 机器人没在跑时显示“机器人未运行：启用后将注入”（静态预览，不伪造运行期工具名）。
- 预览与真正注入共用 `src/extension-prompts.js`：`skillExtPlanOf()`（Skill）与
  `extensionPlanOf()`（插件）。页面说注入什么，模型就收到什么。

---

## 5. 安装 ZIP

`POST /api/extensions/install?overwrite=1&kind=skill|plugin`

- `kind` 可选；带上时会校验清单/目录与声明一致（`expectedKind`）。
- 一个 ZIP 里同时有 `plugin.json` 与 `skill.json` ⇒ 拒绝（避免“到底装成哪一种”）。
- Skill 包必须含 `index.js`（纯提示词也一样）。
- **装完不自动启用**；白名单仍由用户勾选。

---

## 6. 安全边界（重要）

**两型都不是沙箱**：包在机器人进程内加载，能直接 `import fs`、能发网络请求。
宿主只做三件事：

1. `permissions` 裁剪后的 `api`（`fetch` 白名单、`onebot` 只读代理等）；
2. 清单校验与白名单加载（目录里有 ≠ 会生效）；
3. 失败可见（加载失败 / 钩子未挂 / 工具未注册都进报告，不静默）。

只安装你信任的包。详见 `.github/SECURITY.md`。

---

## 7. 自测与门禁

```bash
NODE_OPTIONS= node scripts/check-wb.mjs     # 契约（§167 Skill 扩展域）
NODE_OPTIONS= node scripts/mutate-lint.mjs  # 变异清单锚点
NODE_OPTIONS= node test/smoke.js            # T437–T446 行为
NODE_OPTIONS= node test/panel-dom.mjs       # Skill 页真实渲染
npm run verify                              # 全套
```

定向变异：`test/mutations/extensions-skill-2026-10-28.mjs`（M1–M7，全部应 BLOCKED）。
