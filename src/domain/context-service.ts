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
  path: string[];
  depth: 1 | 2;
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

function propagation(relation: Relation, source: string): { affected: string; direction: string } | undefined {
  if (relation.type === "affects" && source === relation.from) {
    return { affected: relation.to, direction: `${relation.from} -> ${relation.to}` };
  }
  if (
    (relation.type === "depends_on" || relation.type === "constrained_by") &&
    source === relation.to
  ) {
    return { affected: relation.from, direction: `${relation.to} -> ${relation.from}` };
  }
  if (relation.type === "conflicts_with") {
    if (source === relation.from) return { affected: relation.to, direction: `${relation.from} <-> ${relation.to}` };
    if (source === relation.to) return { affected: relation.from, direction: `${relation.to} <-> ${relation.from}` };
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

  const visited = new Set(targetIds);
  const queue: Array<{ id: string; path: string[]; depth: number; certain: boolean }> =
    targetIds.map((id) => ({ id, path: [id], depth: 0, certain: true }));
  const recordedRelations = new Set<string>();
  const recordedGaps = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const relation of relations) {
      const propagated = propagation(relation, current.id);
      if (!propagated) continue;
      const nextDepth = current.depth + 1;
      if (visited.has(propagated.affected)) {
        if (current.path.includes(propagated.affected) && !recordedGaps.has(`${relation.id}:cycle_detected`)) {
          coverageGaps.push({ relation_id: relation.id, reasons: ["cycle_detected"] });
          recordedGaps.add(`${relation.id}:cycle_detected`);
        }
        continue;
      }
      if (nextDepth > 2 || recordedRelations.has(relation.id)) continue;
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
      if (!current.certain) reasons.push("upstream_uncertain");
      if (nextDepth === 2) reasons.push("multi_hop_uncertain");
      const path = [...current.path, propagated.affected];
      const item: ImpactItem = {
        rule: affectedRule,
        relation,
        direction: propagated.direction,
        path,
        depth: nextDepth as 1 | 2,
      };
      if (reasons.length === 0) definiteImpacts.push(item);
      else {
        possibleImpacts.push(item);
        coverageGaps.push({ relation_id: relation.id, reasons });
        for (const reason of reasons) recordedGaps.add(`${relation.id}:${reason}`);
      }
      recordedRelations.add(relation.id);
      visited.add(propagated.affected);
      queue.push({ id: propagated.affected, path, depth: nextDepth, certain: reasons.length === 0 });
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
