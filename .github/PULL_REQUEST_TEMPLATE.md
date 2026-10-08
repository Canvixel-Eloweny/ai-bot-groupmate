# 提交说明（Pull Request）

> 本项目对**工程纪律**的要求比一般项目高一些，所以这份模板比常见的长。
> 每一项都对应一次真实踩过的坑，不是仪式 —— 逐条看完大概一分钟，能省掉最贵的那类来回。
> 动笔前请先读 [`CONTRIBUTING.md`](../CONTRIBUTING.md)。

## 这个 PR 做了什么

<!-- 一句话说清。若修缺陷，请写明"改之前会怎样 / 改之后会怎样"。 -->

## 为什么需要它

<!-- 解决什么问题？关联 issue 请写 Closes #N —— 否则合并后 issue 不会自动关闭。 -->

## 提交前自查

- [ ] `npm run verify` 全过（四层门禁：`check-wb` 静态契约 / `smoke` 行为回归 / 沙箱里的 `presets` 与面板自检）
- [ ] 每处**行为改动**都配了一条"只打它那一条"的变异测试（`test/mutations/`，写法见 `CONTRIBUTING.md`）
- [ ] `npm run publish:audit` 退出码为 0 —— 没有把真实 QQ 号 / 群号 / 密钥 / 本机路径带进仓库
- [ ] 没有提交运行时数据：`config.json`、`data/`、`panel/*.jsonl`、`napcat/`、`.env` 都不该出现在 diff 里
- [ ] `CHANGELOG.md` 补了一行（**只有对外可见的变化**才需要）
- [ ] 若借鉴了新项目 / 新增了依赖：已登记进 [`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md)

## 没把握的地方

<!-- 有取舍、有妥协、有"我也不确定这样对不对"的地方，写在这里比藏在代码里好。
     审阅者最需要知道的往往不是"你做了什么"，而是"你不确定什么"。 -->
