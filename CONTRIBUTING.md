# 贡献指南

感谢你有兴趣参与。这个项目对**工程纪律**的要求比一般项目高一些，所以请先读完这一页再动手 ——
它会替你省掉最贵的那类来回。

## 一、先建立上下文（不要上来就改）

| 你想做的事 | 先读 |
|---|---|
| 搞清楚项目现在处于哪一步 | 内部进度台账（**唯一进度真相源**；内部件，不随公开仓库发布） |
| 改 `src/` 之前 | `docs/ARCHITECTURE.md`（分层与依赖方向） |
| 改面板前端 | `docs/FRONTEND-V2.md` |
| 动效 / 视觉参数 | `docs/MOTION-METHODOLOGY.md` |
| 面板 API | `docs/API_CONTRACT.md` |
| 对外发布 | 维护者的发布清单（内部件，不随公开仓库发布；`npm run publish:audit` 是它的可执行判据 —— 该脚本同样只住在维护者仓库里） |

## 二、铁律（这些不是建议）

1. **一份语义，一份实现。** 同一件事在两处各写一遍 = 它们迟早漂移，而漂移不会报错。
   能接进已有入口就接，不要新开口子。
2. **判据要可执行，不要靠自觉。** 任何"以后别忘了 X"的约定，都必须有东西盯着它
   （契约 / 断言 / 测试）。人会忘，脚本不会。
3. **契约与用例只增不减。** 唯一的例外是"被断言的对象被删掉了" ——
   此时两处计数同向各减 1，并在注释里写清理由。
4. **新契约必须配变异。** 一条判据如果"改坏了也不红"，它等于没有。
   变异清单走 `test/mutations/`（参考 `test/mutations/README.md`）。
5. **"断言存在" ≠ "断言接线"。** 判"某常量被消费"时，先剥掉 import 行再找。
6. **有落盘就要三件套**：`.gitignore` 一行 + `test/sandbox.sh` 的 `--exclude` +
   `QQBOT_*` 环境变量覆盖。漏任一件都不会报错。
7. **不确定就写不确定。** 禁止把"未能判定"写成 `false`，也禁止编造阈值。

## 三、开发与验证

```bash
npm install
npm start                      # 启动机器人（需要 protocol 端，见 INSTALL-DOCKER.md）

# 四层门禁（改动后必须全绿）
node scripts/check-wb.mjs              # L1 静态契约
NODE_OPTIONS= node test/smoke.js       # L2 行为回归
NODE_OPTIONS= bash test/sandbox.sh --run   # L3 预设 + L4 面板（自动收尾）
node scripts/publish-audit.mjs         # 发布前审计（改了会随仓库发布的文件时必须跑；⚠️ 该脚本不随公开仓库发布，外部贡献者跑不了这一条）

# 变异测试（新契约必配）
NODE_OPTIONS= node scripts/mutate.mjs --only <清单名>
```

⚠️ **`NODE_OPTIONS=` 前缀不能省**：不带上它，某些环境下 `err.code` 会被外层改写，
造成一批与代码无关的假红。

⚠️ **跑 `test/smoke.js` 之前确认面板没在跑**（`lsof -ti :8787`）。

## 四、提交

- 一个提交只做一件事；提交信息写**为什么**，不写"改了什么"（diff 自己会说）。
- `src/*.js` 的改动**只对新启动的进程生效** —— 验证"改动真的生效"要用
  `panel/effective.json` 的 `since` 与文件 mtime 对照，不要凭"我改了"下结论。
- 不要提交 `config.json`、`.env`、`napcat/`、`data/`、`skills/`、`plugins/`（第三方包）——
  它们已在 `.gitignore` 里。**也不要提交任何真实 QQ 号 / 群号 / 昵称 / 密钥。**

## 五、许可

本项目以 **Apache-2.0** 发布。除非你明确另行声明，你提交的贡献按 Apache-2.0 第 5 条授权给本项目
（inbound=outbound，无需另签 CLA）。提交即表示你确认自己有权这样授权。
来源与借鉴声明见 `THIRD-PARTY-NOTICES.md`。
