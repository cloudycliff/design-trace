# Design Trace 实施进度

> 最后更新：2026-09-17  
> 设计基线：`design-trace-architecture-and-roadmap.md` v0.7  
> 当前结论：T01～T03 已形成固定夹具上的可运行切片；T04 已完成独立操作员执行审批原型；尚未达到阶段 0 或阶段 1 退出条件。

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

### T03 上下文与验证基础（固定树切片）

- 从指定 Git commit 加载 Rule、Binding、Relation、Evidence 与项目检查注册表，不读取可变工作区。
- 生成带 `source_tree_oid` 和稳定 `context_digest` 的上下文包。
- 实现显式关系的一层传播；仅将来源可靠、已验证、两端版本匹配且证据存在的关系列为确定影响。
- 将未验证、版本过期或证据缺失的关系降级为可能影响，并明确列出覆盖缺口。
- 实现 JSON Pointer 提取与 Rule/Binding 精确对账，区分 `consistent`、`conflict`、`design_only` 和 `unknown`。
- 实现结构、参数、命令回归及人工检查结果模型；required 非 `passed` 时批次不能通过。
- 验证批次持久化到运行目录；每条结果绑定 Git tree、输入清单摘要、运行器摘要、环境摘要和内容寻址日志。
- 命令验证在独立 clone 中运行；验证期间修改输入会被判为错误。
- CLI 新增 `context`、`reconcile` 和 `validate`。

### T04 操作员计划批准（执行阶段原型）

- `context_id` 改由内核根据正式 Git 树的上下文摘要生成，调用方不能伪造或覆盖。
- 执行审查摘要绑定 Change、计划版本、基线 commit、计划摘要、上下文摘要和策略版本。
- 操作员批准记录使用独立密钥生成 HMAC 完整性标签；密钥只保存在 `operator/` 运行目录。
- 最小审查页只绑定 `127.0.0.1`，校验 Host、Origin、HttpOnly/SameSite Cookie、CSRF token 和一次性 nonce。
- 面向普通 CLI/MCP 的审查请求不返回 nonce，也不存在可传入 `approved: true` 的接口。
- 审查页展示用户请求、目标、风险、允许路径、保护检查以及确定/可能影响。
- 批准有效期默认 24 小时；过期、篡改、错计划、错上下文和 nonce 重放均被拒绝。
- 修改已批准计划会回到草稿，生成新版本并从事件投影中清除旧执行批准。
- `start-execution` 在创建尝试前重新验证批准；无批准时无状态副作用。

## 当前验证结果

2026-09-17 本地执行：

| 命令 | 结果 | 覆盖 |
|---|---:|---|
| `npm test` | 26 通过 | T04 审批绑定、过期/篡改/重放拒绝、浏览器来源与 CSRF、计划修改后批准失效，以及 CLI、T01～T03 既有测试 |
| `npm run fixture:test` | 5 通过 | 0、1、19、100、101 金币在普通/困难模式下的 10% 向下取整基线行为 |

这些测试只覆盖当前切片，不代表第 15.1 节 A01～A22 已全部通过。

## 尚未完成与已知限制

- T01：尚未由内核生成 bootstrap 回执；当前夹具内只有 bootstrap Change。
- T01 / 阶段 0：缺少真实项目、真实初始 commit、稳定程序入口、原有测试和用户确认的业务含义。
- T02：Rule、Decision 等其余正式对象尚无完整 Schema；写锁的崩溃后陈旧锁判定和所有写接口的统一幂等包装尚未实现。
- T03：当前只支持一层关系和显式 JSON Binding；尚未接入 Change 的候选快照、计划派生期望值、人工 Evidence 录入及二层“可能影响”。
- T04：当前只实现 execution 批准；操作员会话为进程内状态，尚未实现拒绝/取消界面、服务重启恢复和 result 批准。
- T05 以后：执行副本、候选冻结、验证隔离、结果 bundle、Git CAS 发布、恢复、回退、MCP 与 Skill 均未实现。
- 当前 YAML 校验仅覆盖首个夹具所需字段，还不是全部正式对象的完整 JSON Schema 验证。
- 事件追加遵循单内核串行假设，尚无跨进程写锁；并发启动内核不在当前已验证范围内。

## 下一步开发顺序

1. 收尾 T02：补齐正式对象 Schema、批准失效事件、陈旧锁安全恢复和统一操作幂等包装。
2. 收尾 T03：补齐候选期望值并把 ValidationRun 接入 Change 事件链。
3. 收尾 T04：增加退回/取消、操作员会话恢复与批准异常恢复。
4. 推进 T05：独立执行副本、白名单差异检查和候选 Git 树冻结。
5. 获得真实试点资料后补写阶段 0 记录；在此之前不宣称阶段 0 完成。

## 后续接手入口

- 产品与安全契约：`docs/design-trace-architecture-and-roadmap.md`
- 当前状态：本文
- 状态机：`src/core/state-machine.ts`
- 恢复与幂等原型：`src/core/event-store.ts`
- ChangePlan 契约：`src/domain/change-plan.ts`
- Change 会话服务：`src/domain/change-session-service.ts`
- 上下文与影响分析：`src/domain/context-service.ts`
- JSON 对账：`src/domain/reconciliation.ts`
- 固定树验证器：`src/domain/validation-service.ts`
- 批准签发与校验：`src/operator/approval-authority.ts`
- Loopback 审查页：`src/operator/operator-server.ts`
- 正式仓库初始化：`src/formal/formal-repository.ts`
- 基线校验：`src/formal/project-validator.ts`
- 首条验收夹具：`fixtures/death-penalty/`
