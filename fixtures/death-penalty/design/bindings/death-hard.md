---
schema_version: 1
id: BIND-DEATH-HARD
version: 1
rule_id: RULE-DEATH-HARD
rule_field: parameters.penalty_bps
path: config/death-penalty.json
pointer: /hard/penalty_bps
value_type: integer
unit: bps
conditions:
  difficulty: hard
comparator: exact
environment: local-test
verification_check_id: CHECK-HARD-UNCHANGED
created_at: 2026-09-17T00:00:00Z
---

# 困难模式配置绑定
