# Design Trace 实施进度

> 最后更新：2026-09-18
> 设计基线：`design-trace-architecture-and-roadmap.md` v0.7  
> 当前结论：T01～T08 的工程纵向切片已在固定夹具上连通；MCP 不具备签批能力，流程 Skill 保留两次独立操作员批准。尚未完成真实项目连续试用，因此未达到个人 MVP 退出条件。

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

### T05 执行、候选冻结与快照验证（固定夹具切片）

- 批准后从正式 bare repository 创建独立执行 clone，并固定到计划的 baseline commit。
- 执行副本移除 `origin`，不携带操作员密钥或已配置的正式发布远端。
- 冻结前读取完整 Git 状态；未声明文件、删除、重命名、符号链接和白名单外路径均被阻断。
- 对允许的 JSON 文件计算叶级 JSON Pointer 差异；`before`、`after` 或字段集合与计划不完全一致即拒绝。
- 内核重建 index 并以 `--no-verify` 创建快照提交，不接受 Agent 自带提交历史或 hooks 结果。
- 快照通过 `refs/dt/snapshots/<change>/<attempt>` 保存在正式对象库的内部引用中，但不更新 `dt-main`。
- 冻结前后校验工作目录内容摘要；冻结后工作区继续变化不会进入快照或验证。
- 候选验证从快照 commit 创建独立验证副本，按 Binding 将计划目标值注入参数检查。
- required 检查全部通过才进入 `awaiting_result_approval`；失败进入 `blocked`，运行异常进入 `interrupted`。
- CLI 新增 `freeze-candidate` 和 `validate-candidate`。

### T06 结果审查与正式发布（固定夹具切片）

- 从活动执行快照组合不可变 payload：同时更新业务配置与对应 Rule 版本，并写入正式 Change、计划、上下文、执行批准和验证批次。
- 验证日志按 SHA-256 保存到 `design/artifacts/sha256/`；构建时重新核对日志内容、计划摘要、上下文摘要、快照 ref/tree 和全部 required 检查。
- payload 通过 `refs/dt/payloads/<change>/<bundle>` 保留；ReviewBundle 绑定 payload tree、执行树、验证运行、计划、上下文、影响、策略和执行批准。
- 操作员服务增加独立结果审查页，继续执行 Host、Origin、HttpOnly/SameSite Cookie、CSRF 和一次性 nonce 校验。
- 结果批准使用 HMAC 完整性标签，严格绑定一个活动 bundle 的 `review_digest`；没有普通 CLI 批准入口，也不能用于另一个 bundle。
- 最终树只在 payload 上追加结果 Approval 和包含完整 ReviewBundle 的确定性回执；最终 commit 直接以计划基线为父提交。
- 发布前写入 `commit_prepared`，再使用 `git update-ref <ref> <new> <old>` 完成 compare-and-swap；基线被推进时返回 `STALE_BASELINE` 且不覆盖竞争引用。
- CAS 已成功但响应或 applied 事件丢失时，根据准备记录和正式引用恢复同一个 commit，不重复创建正式结果。
- `build-result-review` 与 `commit-change` 支持幂等键；CLI 新增 `build-result-review`、`review-result` 和 `commit-change`。

### T07 历史查询与补偿回退（固定夹具切片）

- 当前设计查询固定读取 `dt-main`，返回 Rule、字段绑定对账、正式 commit、当前 Change 理由、适用 Decision 和来源路径。
- Rule 历史直接遍历正式 Git 提交，保留各版本、关联 Change、理由及时间；理由缺失时明确返回 `unknown`。
- Decision 加载支持字段级 target、Rule 的 `decision_bindings` 和带范围的 `supersedes` 数据结构，不按最新记录猜测当前理由。
- `propose-revert` 从正式 Change、回执中的 ReviewBundle 和原计划生成当前基线上的新 `kind: revert` 计划，反转精确 JSON Pointer 差异。
- 回退不删除旧 Change、批准、证据或回执；重新执行完整的计划批准、候选验证、结果批准和 CAS 发布，Rule 版本继续递增。
- 若目标配置字段或对应 Rule 字段被后续 Change 修改，返回 `REVERT_CONFLICT` 及精确冲突位置，不自动合并或机械 `git revert`。
- CLI 新增 `query-design`、`get-history` 和 `propose-revert`。

### T08 Agent 接入（固定夹具切片）

- 增加本地 stdio MCP 入口，公开查询、计划、状态、上下文、影响分析、审查请求、执行、冻结、验证、bundle、发布、取消和补偿回退工具。
- MCP 复用已有领域服务与幂等/状态检查，不另建可绕过约束的写入路径。
- MCP 工具集中不存在 approve/sign 能力；`request_review` 只返回操作员页面路径，执行批准与结果批准仍只由 loopback UI 签发。
- 增加幂等 `cancel_change`；提交中任务必须先恢复发布结果，已发布任务必须走补偿 Change，不能伪装成取消。
- 增加仓库内 `design-trace` Skill，明确查询、普通变更、补偿回退、两次批准和错误停止条件。
- 增加 MCP 初始化/工具发现、无签批能力、正式查询和取消语义测试，以及 Agent 接入配置文档。

## 当前验证结果

2026-09-18 本地执行：

| 命令 | 结果 | 覆盖 |
|---|---:|---|
| `npm test` | 40 通过 | T08 MCP 协议、工具边界、取消语义，T07 历史/补偿回退，以及 T01～T06 既有测试 |
| `npm run fixture:test` | 10 通过 | 0、1、19、100、101 金币在普通/困难模式下按配置值向下取整的程序行为 |

这些测试只覆盖当前切片，不代表第 15.1 节 A01～A22 已全部通过。

## 尚未完成与已知限制

- T01：尚未由内核生成 bootstrap 回执；当前夹具内只有 bootstrap Change。
- T01 / 阶段 0：缺少真实项目、真实初始 commit、稳定程序入口、原有测试和用户确认的业务含义。
- T02：Rule、Decision 等其余正式对象尚无完整 Schema；写锁的崩溃后陈旧锁判定和所有写接口的统一幂等包装尚未实现。
- T03：当前只支持一层关系和显式 JSON Binding；尚未接入 Change 的候选快照、计划派生期望值、人工 Evidence 录入及二层“可能影响”。
- T04：execution 与 result 两阶段批准已实现；操作员会话仍为进程内状态，尚未实现拒绝/取消界面和服务重启恢复。
- T05：尚未接入真实 Agent 进程生命周期、停止确认、修复重试与候选 Rule 自动生成；当前仅支持计划明确列出的既有 JSON 文件。
- T06：当前按首个 JSON/Rule 夹具生成正式对象；尚未覆盖通用 Rule 字段变更、完整对象 Schema、索引重建失败状态和所有 commit 创建前中断点。
- T07：已支持字段级 Decision 读取和 unknown 理由，但尚无单独的 Decision 提案/录入流程；依赖冲突当前覆盖目标配置与 Rule 字段的后续变化。
- T08：MCP 与流程 Skill 已实现；两个自动化夹具迭代已覆盖修改与回退，但真实项目连续试用及使用成本指标仍需真实项目输入。
- 当前 YAML 校验仅覆盖首个夹具所需字段，还不是全部正式对象的完整 JSON Schema 验证。
- 事件追加遵循单内核串行假设，尚无跨进程写锁；并发启动内核不在当前已验证范围内。

## 下一步开发顺序

1. 收尾 T02：补齐正式对象 Schema、批准失效事件、陈旧锁安全恢复和统一操作幂等包装。
2. 收尾 T03：补齐候选期望值并把 ValidationRun 接入 Change 事件链。
3. 收尾 T04：增加退回/取消、操作员会话恢复与批准异常恢复。
4. 补齐 Mandatory 工程验收中尚未覆盖的备份/恢复、外部引用篡改和兼容性案例。
5. 收尾完整对象 Schema、陈旧锁恢复、操作员会话恢复和通用 Rule 变更等工程限制。
6. 获得真实试点资料后执行两个连续迭代并补写阶段 0/3 记录；在此之前不宣称个人 MVP 完成。

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
- 执行范围与快照：`src/domain/candidate-service.ts`
- payload、bundle 与 CAS 发布：`src/domain/publication-service.ts`
- 设计历史与补偿回退：`src/domain/history-service.ts`
- Agent 服务适配：`src/mcp/design-trace-mcp.ts`、`src/mcp/stdio.ts`
- Agent 流程 Skill：`skills/design-trace/SKILL.md`
- 正式仓库初始化：`src/formal/formal-repository.ts`
- 基线校验：`src/formal/project-validator.ts`
- 首条验收夹具：`fixtures/death-penalty/`
