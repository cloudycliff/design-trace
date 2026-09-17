# Design Trace 实施进度

> 最后更新：2026-09-17  
> 设计基线：`design-trace-architecture-and-roadmap.md` v0.7  
> 当前结论：T01 固定夹具与正式引用原型已完成；T02 的 ChangePlan、状态机、事件日志、计划修订、单活动任务和基础幂等已形成可运行切片；尚未达到阶段 0 或阶段 1 退出条件。

## 范围说明

当前仓库没有可供试点的真实游戏项目或既有提交，因此先使用
`fixtures/death-penalty/` 建立文档第 13.1 节的固定死亡扣金样例。夹具通过只表示研发基础设施可运行，不能替代真实项目、真实测试入口和用户验收。

本轮遵循的边界：

- 单用户、Windows 本地、单 Git 仓库、单 JSON 配置。
- 只实现目标先行流程的基础设施，不实现“修改后接管”。
- 正式查询固定读取内核管理的 `refs/heads/dt-main`。
- 没有实现可信审批通道前，不接入 Agent 自动执行和正式发布。

## 已完成

### T01 基线和夹具（部分完成）

- 建立死亡扣金固定夹具：普通/困难模式均为 1000 bps，公式为向下取整。
- 提供普通与困难模式 Rule、JSON Pointer Binding、项目检查注册表和 bootstrap Change。
- 实现从明确 Git commit 初始化内部 bare repository，并建立 `refs/heads/dt-main`。
- 初始化前拒绝脏工作区、Rule/配置不一致、重复对象 ID、符号链接、子模块和危险路径。
- 初始化使用临时目录，校验或建库失败时不留下可见的正式项目目录。
- 正式文件读取只经过 `dt-main`；外部工作目录随后发生变化不会污染正式查询。
- 提供最小 CLI：`init` 和 `show`。

### T02 对象与事务日志（首个可运行切片）

- 增加严格的 ChangePlan v1 JSON Schema 校验：禁止额外字段、危险路径、非法 JSON Pointer、空验收集合和错误版本。
- 实现 v0.7 文档中的 Change 状态及合法转换，终态不可重新打开。
- 实现逐条落盘的 JSONL 事件日志；事件包含连续序号、前序摘要和自身 SHA-256 摘要。
- 计划版本保存为不可变文件，事件日志记录计划摘要与请求摘要；可在中断后恢复计划版本和状态。
- 实现 `begin_change` 和 `revise_plan` 幂等：同键同请求返回已有结果，同键异参报 `IDEMPOTENCY_CONFLICT`。
- 每项目只允许一个未终结 Change；写操作使用独占文件锁阻止并发写入。
- CLI 新增 `begin`、`plan` 和 `status`，无需模型即可创建任务、写入计划并恢复状态。
- 统一首批错误码：状态、幂等、完整性、项目格式、脏基线和不支持资源。

## 当前验证结果

2026-09-17 本地执行：

| 命令 | 结果 | 覆盖 |
|---|---:|---|
| `npm test` | 15 通过 | CLI 完整基础流程、ChangePlan 校验与恢复、内核字段防覆盖、单活动任务、并发写锁、状态转换、终态保护、事件防篡改、幂等冲突、正式引用初始化与隔离、脏基线和绑定错误拒绝、项目 ID 路径保护 |
| `npm run fixture:test` | 5 通过 | 0、1、19、100、101 金币在普通/困难模式下的 10% 向下取整基线行为 |

这些测试只覆盖当前切片，不代表第 15.1 节 A01～A22 已全部通过。

## 尚未完成与已知限制

- T01：尚未由内核生成 bootstrap 回执；当前夹具内只有 bootstrap Change。
- T01 / 阶段 0：缺少真实项目、真实初始 commit、稳定程序入口、原有测试和用户确认的业务含义。
- T02：Rule、Decision、Approval 等其余正式对象尚无完整 Schema；写锁的崩溃后陈旧锁判定、所有写接口的统一幂等包装和批准失效规则尚未实现。
- T03：上下文包、关系遍历、指定 Git 树验证器和配置对账尚未实现。
- T04：独立 loopback 操作员页面、会话、防重放 nonce 和批准签发尚未实现。
- T05 以后：执行副本、候选冻结、验证隔离、结果 bundle、Git CAS 发布、恢复、回退、MCP 与 Skill 均未实现。
- 当前 YAML 校验仅覆盖首个夹具所需字段，还不是全部正式对象的完整 JSON Schema 验证。
- 事件追加遵循单内核串行假设，尚无跨进程写锁；并发启动内核不在当前已验证范围内。

## 下一步开发顺序

1. 收尾 T02：补齐正式对象 Schema、批准失效事件、陈旧锁安全恢复和统一操作幂等包装。
2. 推进 T03：从指定正式 Git 树构建上下文；实现 JSON Pointer 提取、Rule/Binding 确定性对账与基础一层关系查询。
3. 建立固定验证器：结构、参数、行为、回归四类检查均绑定输入与运行器摘要。
4. 完成 T04 的独立操作员批准原型，并用 A02/A03 验证 MCP/CLI 不能自行签发批准。
5. 获得真实试点资料后补写阶段 0 记录；在此之前不宣称阶段 0 完成。

## 后续接手入口

- 产品与安全契约：`docs/design-trace-architecture-and-roadmap.md`
- 当前状态：本文
- 状态机：`src/core/state-machine.ts`
- 恢复与幂等原型：`src/core/event-store.ts`
- ChangePlan 契约：`src/domain/change-plan.ts`
- Change 会话服务：`src/domain/change-session-service.ts`
- 正式仓库初始化：`src/formal/formal-repository.ts`
- 基线校验：`src/formal/project-validator.ts`
- 首条验收夹具：`fixtures/death-penalty/`
