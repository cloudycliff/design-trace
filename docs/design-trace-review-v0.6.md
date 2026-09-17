# Design Trace v0.6 设计评审

> 历史评审：下列引用固定指向归档 v0.6。当前设计见 [v0.7 研发基线](C:/Users/admin/Documents/ChatGPT/gd/docs/design-trace-architecture-and-roadmap.md)，问题处置见其第 17 节。

评审日期：2026-09-17。对象：[《Design Trace：产品设计与开发计划》v0.6](C:/Users/admin/Documents/ChatGPT/gd/docs/archive/design-trace-architecture-and-roadmap-v0.6.md:1)。

结论：产品方向合理，适合进入范围受限的原型验证；当前文档尚不足以作为完整 MVP 的工程验收规格。主要问题是“可审查、不可绕过、原子生效、可回退”等承诺缺少闭合的执行契约，以及开发阶段之间的依赖不一致。它们可以修正，无须推翻 Markdown/Git 和确定性内核的总体架构。

本次检查了全文的产品目标、模型、流程、工具接口、开发路线及相互一致性。工作区未见 DT 状态内核、MCP 服务及其测试实现；以下是文档层面的缺陷和风险分析，不代表已经在实现中复现故障，也没有进行性能或工期验证。

**产品目的与用户价值**

DT 服务于使用 AI 修改游戏代码、配置和设计的个人开发者或策划。它希望把一次修改串成可核查的记录：用户为什么改、允许改什么、AI 实际改了什么、验证是否支持结果，以及以后如何查询和撤回。

两条入口是互补的：

- 意图优先：提出目标 → 形成变更边界 → 提供相关设计与历史 → 执行 → 核对差异和验证 → 审批提交。
- 修改优先：直接编辑 Markdown、Excel、配置或代码 → 检测并聚合实际差异 → 补充无法从差异恢复的理由 → 审查提交。

正式设计、决策理由、修改事务、证据和实现事实分别由 Rule、Decision、Change、Evidence、ObservedFact 表达；Relation 提供影响分析的依据。Markdown/YAML + Git 保存正式状态，索引和展示页面从正式状态生成。

产品收益应体现为减少错误修改与返工、缩短查找历史原因的时间，并且增加的审查成本足够低。记录数量和文档数量不能单独证明价值。

**原文研发步骤**

| 阶段 | 计划交付 | 评审意见 |
|---|---|---|
| 0：真实任务验证 | 一个系统、10～20 条规则、3～5 条历史决策、九个真实任务 | 选样本合理；退出条件已包含后续多个阶段的完整能力 |
| 1：状态内核 | Schema、版本、差异接管、校验、审计和回退 | 应优先解决批准内容与提交内容一致、正式状态指针和异常恢复 |
| 2：MCP 与 Skill | 自然语言入口、上下文包、执行核对、审批 | 必须已有可信的批准入口与最低限度影响分析 |
| 3：实现反推与对账 | 单一配置格式、有限代码提取、外部修改接管 | 应拆开配置适配与代码语义提取，先建立规则与实现的明确绑定 |
| 4：影响分析 | 显式关系、正反向遍历、过期检查 | MVP 已依赖这些能力，基础部分应提前 |
| 5：审查界面 | 差异、验证、确认和历史 | 完整界面可后置；可信批准入口不能跟着后置 |
| 6：插件打包 | 初始化、迁移、恢复和跨 Agent 适配 | 应在真实闭环验证后投入 |
| 7：真实项目试用 | 两个完整设计迭代、正确性与使用成本评估 | 应在首次纵向闭环后开始，持续贯穿开发 |

原文估计一名开发者 1～2 周完成原型，累计 4～6 周完成个人 MVP，6～9 周完成有限反推，10～14 周完成界面和插件。只有在单仓库、单 Agent、单一配置格式、现成测试和严格限制自动判断能力的条件下，这组估计才适合作为探索性预算。当前尚未选定引擎、语言、配置格式和验证条件，不能据此承诺交付日期。

**合理且值得保留的设计**

- 将当前规则、历史理由和一次修改分开，避免新规则覆盖旧决策背景。
- 区分实现事实与设计意图，不允许从代码自动编造原因。
- 让程序管理正式状态，AI 负责提案、解释和候选关系，职责方向正确。
- 正式状态只有一个来源，索引可重建，适合单用户、小规模本地项目。
- 支持修改后接管和连续调参聚合，符合策划实际工作习惯。
- 明确呈现未知，推迟向量库、复杂图谱和多人实时协作，范围控制基本合理。

**具体问题与修正建议**

P1 表示在承诺对应能力、进入相关工程验收前必须解决；P2 表示可以继续做原型，但应在扩大使用前修正。并非所有问题都阻止启动阶段 0。

**R1 · P1：审批权与执行权尚未形成可验证的边界。**

依据：[执行器职责](C:/Users/admin/Documents/ChatGPT/gd/docs/archive/design-trace-architecture-and-roadmap-v0.6.md:167)、[MCP 工具约束](C:/Users/admin/Documents/ChatGPT/gd/docs/archive/design-trace-architecture-and-roadmap-v0.6.md:810)、[待确认的提交拦截方式](C:/Users/admin/Documents/ChatGPT/gd/docs/archive/design-trace-architecture-and-roadmap-v0.6.md:1202)。

文档要求 AI 不得自行批准，但同时列出 `approve_change`，没有说明谁能调用、服务如何识别人类批准、确认凭证由谁生成。若服务仅接受模型传入的“用户已确认”，审批仍然依赖模型自述。若执行器还能直接更新正式 Git 引用，它也可以绕开 MCP。

建议明确支持的信任边界：个人 MVP 可以防止误操作，但若要承诺执行器无法绕过，必须提供执行器不能替代的人类批准通道，并限制正式状态的更新入口。独立工作树只能隔离文件操作，不能自动构成权限隔离。

批准记录至少应绑定变更 ID、提案版本、被审查内容摘要、审批阶段和适用策略。模型可以请求批准，不能自行产生有效的人类批准凭证。普通本地 Git hook 可以减少误操作，但不应被描述为不可绕过的权限机制。

验收：模型自行调用批准接口、复用其他 Change 的凭证或提交未经批准的正式引用更新时，应被拒绝，或被明确识别为不在产品所承诺的受控路径内。

**R2 · P1：校验、审查与提交之间存在内容变化窗口。**

依据：[正式提交步骤](C:/Users/admin/Documents/ChatGPT/gd/docs/archive/design-trace-architecture-and-roadmap-v0.6.md:575)、[实际 diff 与确认凭证](C:/Users/admin/Documents/ChatGPT/gd/docs/archive/design-trace-architecture-and-roadmap-v0.6.md:823)。

检查基线 commit 和 Rule 版本只能发现基线过期，不能保证工作区内容没有变化。典型场景是：用户批准候选 A，测试通过；编辑器或 Agent 又产生修改 B；正式提交读取了 A+B。此时基线 commit 仍相同，审批和测试却都不覆盖 B。单用户也会遇到这种并发。

建议先形成不可变候选快照，再执行验证和最终审批；正式提交必须使用该快照。审批绑定整个审查包，测试证据绑定对应的代码、配置与测试定义摘要。任何实质修改均使相关验证或批准失效。提交时原子检查并更新预期的正式 Git 引用，发生竞争则重新审查。

同时定义工作区已有修改、暂存区内容、未跟踪文件和其他任务修改如何归属，不能把所有直接编辑默认合入本次 Change。持久化 Change ID 与提交结果，使“提交成功但响应丢失”后的重试不会产生重复事务。

验收：批准后继续改文件、验证后改文件、两个提交竞争、成功后丢失响应四类场景都不能让未经审查的内容生效。

**R3 · P1：原子生效与回退的资源边界不清楚。**

依据：[全部生效或完全不生效](C:/Users/admin/Documents/ChatGPT/gd/docs/archive/design-trace-architecture-and-roadmap-v0.6.md:52)、[外部工具修改](C:/Users/admin/Documents/ChatGPT/gd/docs/archive/design-trace-architecture-and-roadmap-v0.6.md:545)、[Git 正式状态边界](C:/Users/admin/Documents/ChatGPT/gd/docs/archive/design-trace-architecture-and-roadmap-v0.6.md:584)、[MVP 提交对象](C:/Users/admin/Documents/ChatGPT/gd/docs/archive/design-trace-architecture-and-roadmap-v0.6.md:1039)。

如果设计记录、代码和配置都在同一仓库，Git 可以原子发布一个完整的仓库快照。但仅提交设计记录和实现引用，不会让另一个仓库、仓库外 Excel、已经上传的配置或运行时数据同时生效，也不会自动撤销这些外部效果。文档没有明确要求相关实现文件与设计同仓、同次提交。

建议 MVP 明确限制为一个受控仓库中的版本化文件，原子性只覆盖正式仓库快照。外部文件先导入不可变快照；跨仓库提交、部署和运行时数据恢复另立能力边界。已经执行的紧急修改应展示“实现已变、设计待对账”，不能让正式设计状态隐含代表当前运行状态。

还需定义哪个受控 Git 引用代表正式状态。查询及索引失败后的降级读取都应读取该引用对应的文件，不能退回读取含有草稿的工作区。“上一有效 commit”不是足够明确的读取协议。

验收：提交失败后正式引用不变；索引损坏且工作区含未审批修改时，查询仍返回正式版本；回退只能承诺恢复已纳入事务边界的资源。

**R4 · P1：自然语言边界和业务目标缺少可执行的验证定义。**

依据：[Change 示例](C:/Users/admin/Documents/ChatGPT/gd/docs/archive/design-trace-architecture-and-roadmap-v0.6.md:253)、[核对四层信息](C:/Users/admin/Documents/ChatGPT/gd/docs/archive/design-trace-architecture-and-roadmap-v0.6.md:435)、[验证策略待定](C:/Users/admin/Documents/ChatGPT/gd/docs/archive/design-trace-architecture-and-roadmap-v0.6.md:1200)。

“不降低构筑差异”“缩短战斗时长”无法仅凭文件 diff 和通用 Schema 校验得出确定结论。文件在允许目录中，也可能改变范围外的行为。原文已经要求区分确定越界与推测越界，但还缺少从这些结果进入提交策略的具体规则。

示例本身存在范围冲突：允许修改的是初期敌人属性和技能能量参数，实际目标却是全局冷却，且验收没有检验战斗时长或构筑差异。这应成为一个明确被拒绝的反例，而不应作为正常 Change 模板。

建议把约束分成可检查的路径/配置键/参数约束、有明确执行器的测试断言、需要人工评价的体验目标。每项约束记录验证方式、适用环境、结果和证据；业务指标还需记录基线、口径和目标阈值。路径检查通过不等于语义范围通过。

验证应由内核调用可信的运行入口，保存退出状态、日志摘要及被测内容版本。执行器可以提出新测试，但修改或删除原有验收测试必须单独进入审查，否则读取“真实的测试通过结果”仍可能放过被弱化的测试。

区分两种 unknown：缺少历史原因可以允许记录后继续；强制校验没有执行或结果不明，不能直接当作通过。允许例外时，应显式记录人工豁免及其对象。

验收：范围外的全局冷却修改、被删弱的关键测试、复用旧版本测试结果及缺失领域验收，均不能被普通“测试通过”覆盖。

**R5 · P1：Change 状态机无法表达主流程中的两次批准与执行重试。**

依据：[Change 状态机](C:/Users/admin/Documents/ChatGPT/gd/docs/archive/design-trace-architecture-and-roadmap-v0.6.md:285)、[AI 开发流程](C:/Users/admin/Documents/ChatGPT/gd/docs/archive/design-trace-architecture-and-roadmap-v0.6.md:403)、[MVP 最终审查](C:/Users/admin/Documents/ChatGPT/gd/docs/archive/design-trace-architecture-and-roadmap-v0.6.md:1035)。

当前只有 `ReadyForReview → Approved → Applied`，而主流程需要先批准执行范围，再实施、验证，最后批准实际结果。一个 Approved 无法说明用户批准的是计划还是最终差异。状态机也没有表达执行失败、取消后保留草稿、校验失败后的修订和再次批准。示例的 `status: proposed` 与图中状态也不一致。

建议将提案版本、执行尝试和批准阶段明确分开。最低流程可以是：草稿 → 等待执行批准 → 执行中 → 验证中 → 等待结果批准 → 已应用。拒绝、取消、执行失败和基线过期都应有可恢复路径。每次重新执行生成独立尝试记录，保留所用提案、上下文和证据。

“修改优先”入口不应补造事前批准；它从已观察的修改进入结果审查，并标明入口类型。聊天中断或 MCP 重启后应能从持久化记录恢复，而不是靠会话记忆判断已执行到哪一步。

验收：计划已批准但结果未批准时不能正式提交；修改计划后旧批准失效；中断后可以恢复或取消，不重复执行已完成的提交。

**R6 · P1：设计—实现对账缺少匹配规则和提取覆盖范围。**

依据：[Rule 模型](C:/Users/admin/Documents/ChatGPT/gd/docs/archive/design-trace-architecture-and-roadmap-v0.6.md:189)、[ObservedFact 模型](C:/Users/admin/Documents/ChatGPT/gd/docs/archive/design-trace-architecture-and-roadmap-v0.6.md:314)、[五类对账结果](C:/Users/admin/Documents/ChatGPT/gd/docs/archive/design-trace-architecture-and-roadmap-v0.6.md:663)。

模型目前主要用自然语言 statement 描述规则和事实，没有明确同一规则如何绑定实现符号或配置键、如何处理单位和条件，以及多条事实如何共同支持一条规则。仅靠文字相似度不能可靠地区分一致与冲突。

有限提取器没有发现某项实现，也不等于该实现不存在。例如提取器只支持配置表，规则实际由脚本实现；此时“仅设计存在”应是“提取范围外，无法判断”。文档承认静态实现的限制，但尚未把提取覆盖信息纳入对账判定。

建议首版仅对显式绑定的结构化参数做确定性比较，记录实体、属性、值、单位、条件、环境、来源集合和比较器。自由文本规则只产生候选匹配或人工审查结论。提取批次记录支持范围、失败项、版本及依赖来源，只有覆盖充分才能判断缺失或一致。

验收：配置读取成功但运行覆盖关系未知、目标实现超出提取器能力、单位不同或环境不同的情况，不得自动判为一致或实现缺失。

**R7 · P2：关系模型与存储示例不一致，确定影响的有效期没有定义。**

依据：[关系来源模型](C:/Users/admin/Documents/ChatGPT/gd/docs/archive/design-trace-architecture-and-roadmap-v0.6.md:350)、[确定影响](C:/Users/admin/Documents/ChatGPT/gd/docs/archive/design-trace-architecture-and-roadmap-v0.6.md:600)、[frontmatter 示例](C:/Users/admin/Documents/ChatGPT/gd/docs/archive/design-trace-architecture-and-roadmap-v0.6.md:727)。

Relation 要保存来源、可信度和验证状态，但 frontmatter 仅存目标 ID；目录结构也未说明完整关系记录放在哪里。按示例实现会丢失影响分类的依据。关系还有验证时间，却没有明确被验证的两端版本：昨天确认的关系在今天修改规则后可能已经失效。

建议选定唯一的关系存储形式，保存来源证据及被验证对象版本。定义 `depends_on` 的反向传播、`affects` 的正向传播、冲突的对称性，以及不同关系是否允许传递。过期或未知边不能因 source 是 explicit 就继续产生确定结论。

结果应限定为“在已覆盖、已验证关系中的影响”，展示覆盖缺口；确定存在引用关系也不自动意味着必须修改被引用方。

**R8 · P2：当前决策的选择和历史回退规则不完整。**

依据：[Decision 只追加](C:/Users/admin/Documents/ChatGPT/gd/docs/archive/design-trace-architecture-and-roadmap-v0.6.md:240)、[允许直接编辑 Decision](C:/Users/admin/Documents/ChatGPT/gd/docs/archive/design-trace-architecture-and-roadmap-v0.6.md:513)、[回退流程](C:/Users/admin/Documents/ChatGPT/gd/docs/archive/design-trace-architecture-and-roadmap-v0.6.md:590)。

一条 Decision 可以对应多个 Rule，但没有定义其中一条规则被新决定部分取代时，其他规则如何继续引用旧决定。Rule 也未显式绑定当前有效理由，普通调参又可以没有新 Decision，查询“当前为什么是这个值”容易混用历史解释。

回退不能简单对包含 Rule、Decision、Change 和 Evidence 的整次提交执行反向文件操作，否则会删除应继续保留的正式历史记录。Git 仍保留旧提交，不等于符合领域模型要求的只追加记录。

建议按 Rule 版本与适用范围绑定决策，区分历史理由和本次调整原因。直接编辑已接受的 Decision 应生成勘误或替代记录。回退创建新的补偿 Change，只逆转业务状态并重新验证；历史 Decision、Change、Evidence 保留，回退关系单独记录。

**R9 · P2：阶段退出条件与依赖顺序存在冲突。**

依据：[阶段 0](C:/Users/admin/Documents/ChatGPT/gd/docs/archive/design-trace-architecture-and-roadmap-v0.6.md:856)、[阶段 4](C:/Users/admin/Documents/ChatGPT/gd/docs/archive/design-trace-architecture-and-roadmap-v0.6.md:950)、[MVP 闭环](C:/Users/admin/Documents/ChatGPT/gd/docs/archive/design-trace-architecture-and-roadmap-v0.6.md:1028)。

阶段 0 已要求自动形成边界、识别范围漂移、反推对账、聚合外部调参和恢复代码配置，实际依赖阶段 1～4。若按自动化退出条件执行，就会在“验证阶段”提前开发大量产品。若允许人工辅助，又不能据此证明程序已经具备阻断能力。

建议将阶段 0 改为人工辅助的产品价值实验，同时做少量技术风险原型；明确哪些是人工结果、哪些已有程序保证。基础关系遍历前移到首条闭环，配置反推和有限代码反推拆开；首次真实项目试用前移到闭环完成后。

**R10 · P2：指标有名称，但缺少基准任务、判定口径与通过门槛。**

依据：[评估指标](C:/Users/admin/Documents/ChatGPT/gd/docs/archive/design-trace-architecture-and-roadmap-v0.6.md:1136)。

文档列出的指标覆盖面较好，但没有说明正确答案由谁标注、影响漏检的分母是什么，以及增加多少审查成本仍值得使用。“避免的返工次数”也需要对照或事后证据，不能完全依赖用户主观估计。

建议以固定真实任务和故障样本形成验收集，并与现有 Agent + Git diff + 人工审查流程比较。至少同时统计完成时间、审查耗时、误拦截、遗漏和实际发现的问题。查询要检查答案与引用是否匹配，不能只检查是否附带链接。

受控验收集中，过期批准、替换已审批内容、缺失强制验证和重复提交等样本应全部被正确处理；这是测试集门槛，不代表对任意未知情况作出零故障保证。影响分析、提取准确率和交互成本的数值门槛应在阶段 0 取得基线后确定。

**建议采用的研发顺序**

| 步骤 | 最小交付 | 退出条件 |
|---|---|---|
| 1. 冻结试点与边界 | 一个仓库、一个系统、一种配置、一个 Agent；定义正式引用、批准通道及原子性边界 | 所有必需输入可获得；每条关键约束都有程序验证或人工验收方式 |
| 2. 人工跑通真实任务，验证关键技术风险 | 少量真实规则、历史决策、带预期结果的正常与异常案例；候选快照与批准绑定原型 | 证明记录对决策有用；证明批准后变更不会混入提交 |
| 3. 建立最小状态内核 | Schema、提案/执行/批准记录、快照提交、幂等、恢复和补偿回退 | 版本过期、内容变化、提交中断、重试和历史保留验收通过 |
| 4. 完成第一条 AI 纵向闭环 | 单一 MCP/Skill 入口、明确绑定的规则、基础关系遍历、上下文、一个配置修改、领域校验和最终审查 | 真实修改能提交、解释和回退；诱发的越界修改被识别 |
| 5. 加入修改优先并持续试用 | 同一种配置的稳定 ID 差异、连续调参聚合、人工 Markdown 修改接管 | 两个迭代中能观察到收益、使用成本和绕过原因 |
| 6. 按试用结果扩展 | 有限代码提取、更多对账能力、审查界面、插件迁移与打包 | 新能力有独立样本和验收指标，不破坏既有闭环 |

首条闭环可以选用文档已有的死亡惩罚案例：普通模式由 10% 改到 5%，困难模式保持 10%。它同时具有清晰的配置键、条件分支、规则依据、验证目标和逆向操作，比“缩短战斗时长但保持构筑差异”更适合作为第一条确定性工程验收案例。后者适合之后验证人工判断与模拟证据的接入。

**执行建议**

允许启动范围受限的阶段 0；在编写完整内核前补齐正式状态与事务边界、批准凭证、候选快照、验证契约、状态机以及规则—实现绑定。完整 UI、更多 Agent、代码语义反推和插件发布应建立在已验证的真实闭环之上。原文的 4～6 周个人 MVP 目标需要按上述收缩后的范围重新确认。
