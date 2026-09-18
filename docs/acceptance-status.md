# Mandatory 工程验收状态

> 最后更新：2026-09-18
> 基线：`design-trace-architecture-and-roadmap.md` v0.7 第 15.1 节
> 口径：本表只确认固定夹具上的工程行为；不替代真实项目连续试用和产品收益评估。

## 结果

| 编号 | 状态 | 自动化证据 | 已验证结果 |
|---|---|---|---|
| A01 | 通过 | `history-revert.test.ts`：`formal query ignores unapproved execution changes...` | 查询忽略执行副本改动，从已验证正式 commit 读取，并返回 `index_status: not_available` 与降级标志。 |
| A02 | 通过 | `operator-approval.test.ts`、`mcp.test.ts` | 无批准不能执行；批准与 Change/计划/上下文绑定；MCP 不暴露签批能力。 |
| A03 | 通过 | `operator-approval.test.ts`：`revising an approved plan invalidates...`、批准主题摘要校验 | 计划修订清除旧批准；基线、上下文和策略均参与签批主题并在使用时复核。 |
| A04 | 通过 | `candidate-service.test.ts`：`scope checker rejects...` | 范围外 JSON 键和未声明文件被阻止，候选进入 `blocked`。 |
| A05 | 通过 | `candidate-service.test.ts`：`a changing workspace interrupts snapshot capture...` | 范围检查后继续变化会触发 `CONTENT_CHANGED` 和 `interrupted`，不能形成混合快照。 |
| A06 | 通过 | `candidate-service.test.ts`、`publication-service.test.ts` | 验证只读冻结树；工作副本后续变化不进入 payload；旧 attempt 不能被冻结，批准只绑定活动 bundle。 |
| A07 | 通过 | `publication-service.test.ts`：`result review rejects validation evidence from a different environment` | 发布前复核树、输入清单、检查版本、runner、环境、日志和结果绑定。 |
| A08 | 通过 | `candidate-service.test.ts`、`validation-service.test.ts` | 保护字段/文件越界、验证过程修改输入和日志内容寻址异常均阻止发布。 |
| A09 | 通过 | `validation-service.test.ts`：`required unknown, error, timeout, and missing checks cannot pass` | required 的 failed、unknown、error、timeout 或缺失均不能形成通过批次。 |
| A10 | 通过 | `publication-service.test.ts`：`Git CAS rejects a moved formal baseline...` | `update-ref` CAS 拒绝陈旧基线，不自动合并或覆盖。 |
| A11 | 通过 | `publication-service.test.ts` 的三个 interruption 测试 | commit 创建前、commit 已准备但 CAS 前、CAS 后响应丢失均可恢复；正式引用只发布一次。 |
| A12 | 通过 | `event-store.test.ts`、`change-session-service.test.ts`、`publication-service.test.ts` | 同键同请求复现原结果，同键异参返回 `IDEMPOTENCY_CONFLICT`。 |
| A13 | 通过 | `candidate-service.test.ts`、`operator-approval.test.ts`、`change-session-service.test.ts` | interrupted 可进入新 attempt；过期批准无副作用；取消、活锁拒绝、死锁恢复及三次尝试预算均已验证。 |
| A14 | 通过 | `history-revert.test.ts`：`a compensation Change restores business state...` | 补偿 Change 恢复配置，Rule 版本递增，原 Change 与历史仍存在。 |
| A15 | 通过 | `history-revert.test.ts`：`revert proposal rejects target fields changed...` | 后续字段修改返回精确 `REVERT_CONFLICT`，不执行机械逆操作。 |
| A16 | 通过 | `context-reconciliation.test.ts`：`impact analysis limits propagation to two hops...` | 版本过期/未验证边降级；二层传播始终为可能影响；循环由 visited 集合终止并报告。 |
| A17 | 通过 | `context-reconciliation.test.ts`：`reconciliation returns unknown...` | 提取范围不足、动态覆盖、环境不符、单位不符均返回 `unknown`。 |
| A18 | 通过 | `formal-repository.test.ts`、`event-store.test.ts`、`candidate-service.test.ts`、`formal-integrity.ts` | 重复 ID、引用断链、事件篡改、危险路径、符号链接/子模块和正式历史改写均被拒绝。 |
| A19 | 通过 | `history-revert.test.ts`：`partial Decision supersession retains...` 及 unknown 理由测试 | 字段级部分取代保留未受影响字段的旧理由；无理由参数修改保持 `unknown`。 |
| A20 | 通过 | `history-revert.test.ts`、`publication-service.test.ts` | 查询和写入都核对已验证 commit 账本；外部移动正式引用返回 `INTEGRITY_ERROR`。 |
| A21 | 通过 | `backup-service.test.ts`、`formal-repository.test.ts`：不兼容 Schema 测试 | 备份恢复、Git GC 后引用与快照可读；未用批准失效；不兼容 Schema 阻止新写入且旧 commit 保留。 |
| A22 | 通过（固定夹具） | `history-revert.test.ts`、`publication-service.test.ts`、`fixtures/death-penalty/tests` | 普通/困难模式参数与行为、两次批准、同仓发布、原因查询和补偿回退形成完整闭环。 |

## 尚不构成完成证明的事项

- 尚无用户提供的真实游戏仓库、初始 commit、稳定测试命令和经确认的业务 Rule，因此阶段 0 的真实项目资料未冻结。
- 尚未进行阶段 3 要求的两个真实设计迭代，也没有可与原流程比较的耗时、补问、误拦截和回退成本数据。
- 当前支持范围仍是单用户、Windows 本地、单 Git 仓库和显式 JSON Pointer；完整插件产品化、第二 Agent、代码提取器和通用多格式支持属于证据驱动的后续扩展。

在取得真实试点输入前，固定夹具范围内的 A01～A22 可重复运行；“个人 MVP”与产品价值验证仍不能宣称完成。
