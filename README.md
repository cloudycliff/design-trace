# 项目说明

本目录用于整理项目的设计资料与原始参考工程。

## 目录结构

```text
.
├── docs/       # 项目设计文档
└── source/     # 项目的原始参考工程
```

### `docs/`

存放本项目编写和维护的设计文档，包括架构设计、技术路线、评审记录以及历史版本归档。

### `source/`

存放项目使用的原始参考工程，用于查阅原始实现、资料组织方式和相关内容。该目录包含独立的 Git 仓库，请将其中内容视为参考来源；如果需要修改参考工程，应在其自身的版本管理范围内进行。

## 使用建议

1. 查阅或更新项目方案时，优先查看 `docs/`。
2. 需要核对原始实现或参考资料时，再查看 `source/`。
3. 设计文档与参考工程保持分离，避免直接覆盖原始参考内容。

## 当前实现

项目已按 `docs/design-trace-architecture-and-roadmap.md` 启动 TypeScript/Node.js 内核实现。

```text
src/                         # 状态内核与正式仓库访问
test/                        # 内核行为测试
fixtures/death-penalty/      # 首条死亡扣金固定验收夹具
docs/implementation-progress.md
```

开发环境要求 Node.js 24+ 与 Git。安装依赖后运行：

```powershell
npm test
npm run fixture:test
```

当前实现范围、验证结果、限制和下一步以
[`docs/implementation-progress.md`](docs/implementation-progress.md) 为准。

Agent 接入说明及 MCP 配置示例见 [`docs/agent-integration.md`](docs/agent-integration.md)，流程 Skill 位于
[`skills/design-trace/SKILL.md`](skills/design-trace/SKILL.md)。

当前 CLI 已覆盖初始化、计划、查询、对账、候选验证、结果 bundle 和 CAS 正式发布。审批动作不提供普通 CLI
命令，只能在仅绑定 `127.0.0.1` 的操作员页面完成：

```powershell
node dist/src/cli.js operator-server --data <kernel-data> --project <project-id>
node dist/src/cli.js review-execution --data <kernel-data> --project <project-id> --change <change-id>
node dist/src/cli.js build-result-review --data <kernel-data> --project <project-id> --change <change-id> --key <key>
node dist/src/cli.js review-result --data <kernel-data> --project <project-id> --change <change-id> --bundle <bundle-id>
node dist/src/cli.js commit-change --data <kernel-data> --project <project-id> --change <change-id> --bundle <bundle-id> --key <key>
node dist/src/cli.js query-design --data <kernel-data> --project <project-id> --rule <rule-id> --field parameters.penalty_bps
node dist/src/cli.js get-history --data <kernel-data> --project <project-id> --rule <rule-id>
node dist/src/cli.js propose-revert --data <kernel-data> --project <project-id> --target <change-id> --request <goal> --key <key>
node dist/src/cli.js backup --data <kernel-data> --project <project-id> --destination <backup-path>
node dist/src/cli.js verify-backup --backup <backup-path>
node dist/src/cli.js restore-backup --backup <backup-path> --data <new-kernel-data>
```

将两条 `review-*` 命令返回的 `review_path` 拼接到操作员服务输出的 `origin` 后，在浏览器中完成对应阶段审批。
