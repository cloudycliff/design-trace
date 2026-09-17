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
