# 真实项目试用记录模板

> 用途：补齐阶段 0 输入并记录阶段 3 的两个连续迭代。固定夹具结果不能代替本记录。

## 阶段 0：输入冻结

| 项目 | 待填写内容 |
|---|---|
| 仓库位置 | 本地路径或可访问的 Git URL |
| 初始 commit | 完整 commit OID |
| 试点系统 | 一个边界明确的游戏系统 |
| 配置文件 | 一个版本化 JSON 文件 |
| 程序入口 | 实际读取该配置的入口 |
| 测试命令 | 可重复执行且退出码可信的命令 |
| 运行环境 | OS、Node/引擎版本及关键依赖 |
| 关键 Rule | 约 10 条，经用户确认语义 |
| 历史理由 | 已确认的 Decision；未知项明确写 `unknown` |
| 人工标准 | 不能自动判断但本次必须验收的观察项 |
| 原流程基线 | 平均耗时、补问次数、审查时间和常见失败 |

确认人：`<user>`  
确认时间：`<UTC timestamp>`

## 迭代 1：正常修改与退回重试

- 目标：`<goal>`
- 基线 commit：`<oid>`
- Change / attempts / bundle：`<ids>`
- 故意或真实退回原因：`<reason>`
- 最终 commit：`<oid>`
- 自动检查：`<passed / failed / unknown>`
- 人工验收：`<criterion and result>`
- 总耗时 / 两次审批耗时：`<duration>`
- 补问次数 / 退回次数：`<counts>`
- 误拦截或漏检：`<observations>`

## 迭代 2：补偿回退与故意越界

- 目标：`<goal>`
- 基线 commit：`<oid>`
- Change / attempts / bundle：`<ids>`
- 越界样本及预期错误：`<sample / expected code>`
- 原变更与补偿 Change：`<ids>`
- 回退后 commit：`<oid>`
- Rule 版本与历史保留检查：`<result>`
- 总耗时 / 两次审批耗时：`<duration>`
- 补问次数 / 退回次数：`<counts>`
- 误拦截或漏检：`<observations>`

## 阶段 3 汇总

| 指标 | 原流程 | Design Trace | 结论 |
|---|---:|---:|---|
| 任务成功率 |  |  |  |
| 查询正确率 |  |  |  |
| 漏检 / 误拦截 |  |  |  |
| 影响分析召回 |  |  |  |
| 两次批准总耗时 |  |  |  |
| 补问 / 退回次数 |  |  |  |
| 总完成时间 |  |  |  |
| 原因查询时间 |  |  |  |
| 补偿回退时间 |  |  |  |

最终决定：`继续扩展 / 收缩范围 / 停止投入`  
决定依据：`<evidence-backed conclusion>`
