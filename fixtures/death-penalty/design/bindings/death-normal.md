---
schema_version: 1
id: BIND-DEATH-NORMAL
version: 1
rule_id: RULE-DEATH-NORMAL
rule_field: parameters.penalty_bps
path: config/death-penalty.json
pointer: /normal/penalty_bps
value_type: integer
unit: bps
conditions:
  difficulty: normal
comparator: exact
environment: local-test
verification_check_id: CHECK-NORMAL-PENALTY
created_at: 2026-09-17T00:00:00Z
---

# 普通模式配置绑定
