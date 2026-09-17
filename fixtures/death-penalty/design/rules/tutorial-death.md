---
schema_version: 1
id: RULE-TUTORIAL-DEATH
version: 1
status: active
system: tutorial
statement: 教程中的死亡提示必须展示普通模式当前扣金比例
conditions:
  difficulty: normal
parameters:
  source_rule: RULE-DEATH-NORMAL
acceptance_ids:
  - CHECK-NORMAL-PENALTY
decision_bindings: []
last_change_id: CHG-BOOTSTRAP
created_at: 2026-09-17T00:00:00Z
---

# 教程死亡提示

该规则用于验证一层显式影响关系。
