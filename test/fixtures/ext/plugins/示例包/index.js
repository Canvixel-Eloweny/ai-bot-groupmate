// 示例扩展包入口。
// ⚠️ 第 44 轮（B12d）的宿主**不会** import 这个文件 —— 执行层要等 function calling 链路。
//    它存在只是为了给"入口文件存在性校验"一个真实对象，而不是让那条校验对着空气跑。
export function setup() {}
