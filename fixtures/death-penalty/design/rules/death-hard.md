---
schema_version: 1
id: RULE-DEATH-HARD
version: 1
status: active
system: economy
statement: 困难模式死亡扣除当前金币的 10%，向下取整
conditions:
  difficulty: hard
parameters:
  penalty_bps: 1000
  rounding: floor
acceptance_ids:
  - CHECK-HARD-UNCHANGED
decision_bindings: []
last_change_id: CHG-BOOTSTRAP
created_at: 2026-09-17T00:00:00Z
---

# 困难模式死亡扣金

历史理由尚未确认，当前仅记录可验证的基线行为。
