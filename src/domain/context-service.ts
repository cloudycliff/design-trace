import { digestObject } from "../core/digest.js";
import { DesignTraceError } from "../core/errors.js";
import type { TreeReader } from "../formal/project-validator.js";
import {
  loadFormalObjects,
  type ImplementationBinding,
  type Relation,
  type Rule,
} from "./formal-objects.js";

export interface ImpactItem {
  rule: Rule;
  relation: Relation;
  direction: string;
}

export interface ContextPackage {
  schema_version: 1;
  source_tree_oid: string;
  targets: Rule[];
  bindings: ImplementationBinding[];
  definite_impacts: ImpactItem[];
  possible_impacts: ImpactItem[];
  coverage_gaps: Array<{ relation_id: string; reasons: string[] }>;
  context_digest: string;
}

function propagation(relation: Relation, targets: Set<string>): { affected: string; direction: string } | undefined {
  if (relation.type === "affects" && targets.has(relation.from)) {
    return { affected: relation.to, direction: `${relation.from} -> ${relation.to}` };
  }
  if (
    (relation.type === "depends_on" || relation.type === "constrained_by") &&
    targets.has(relation.to)
  ) {
    return { affected: relation.from, direction: `${relation.to} -> ${relation.from}` };
  }
  if (relation.type === "conflicts_with") {
    if (targets.has(relation.from)) return { affected: relation.to, direction: `${relation.from} <-> ${relation.to}` };
    if (targets.has(relation.to)) return { affected: relation.from, direction: `${relation.to} <-> ${relation.from}` };
  }
  return undefined;
}

export async function buildContext(reader: TreeReader, targetIds: string[]): Promise<ContextPackage> {
  if (!reader.treeOid) throw new DesignTraceError("INVALID_PROJECT", "Context reader must expose a Git tree OID");
  const { rules, bindings, relations, evidenceIds } = await loadFormalObjects(reader);
  const rulesById = new Map(rules.map((rule) => [rule.id, rule]));
  const targets = targetIds.map((id) => {
    const rule = rulesById.get(id);
    if (!rule) throw new DesignTraceError("INVALID_PROJECT", `Unknown target Rule: ${id}`);
    return rule;
  });
  const targetSet = new Set(targetIds);
  const definiteImpacts: ImpactItem[] = [];
  const possibleImpacts: ImpactItem[] = [];
  const coverageGaps: ContextPackage["coverage_gaps"] = [];

  for (const relation of relations) {
    const propagated = propagation(relation, targetSet);
    if (!propagated) continue;
    const affectedRule = rulesById.get(propagated.affected)!;
    const fromRule = rulesById.get(relation.from)!;
    const toRule = rulesById.get(relation.to)!;
    const reasons: string[] = [];
    if (relation.verification !== "verified") reasons.push("unverified");
    if (!(["explicit", "deterministic"] as const).includes(relation.source as "explicit" | "deterministic")) {
      reasons.push("non_deterministic_source");
    }
    if (
      relation.verified_versions.from !== fromRule.version ||
      relation.verified_versions.to !== toRule.version
    ) {
      reasons.push("stale_versions");
    }
    if (relation.evidence_ids.length === 0 || relation.evidence_ids.some((id) => !evidenceIds.has(id))) {
      reasons.push("missing_evidence");
    }
    const item = { rule: affectedRule, relation, direction: propagated.direction };
    if (reasons.length === 0) definiteImpacts.push(item);
    else {
      possibleImpacts.push(item);
      coverageGaps.push({ relation_id: relation.id, reasons });
    }
  }

  const content = {
    schema_version: 1 as const,
    source_tree_oid: await reader.treeOid(),
    targets,
    bindings: bindings.filter((binding) => targetSet.has(binding.rule_id)),
    definite_impacts: definiteImpacts,
    possible_impacts: possibleImpacts,
    coverage_gaps: coverageGaps,
  };
  return { ...content, context_digest: digestObject(content) };
}
