import { DesignTraceError } from "../core/errors.js";
import { parseFrontmatter, parseYamlObject } from "./frontmatter.js";

export interface TreeReader {
  listFiles(): Promise<Array<{ mode: string; path: string }>>;
  readText(path: string): Promise<string>;
  blobOid?(path: string): Promise<string>;
  treeOid?(): Promise<string>;
}

export interface ValidatedBaseline {
  projectId: string;
  pilotSystem: string;
  configPath: string;
  normalPenaltyBps: number;
  hardPenaltyBps: number;
}

function requiredString(object: Record<string, unknown>, field: string, label: string): string {
  const value = object[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new DesignTraceError("INVALID_PROJECT", `${label}.${field} must be a non-empty string`);
  }
  return value;
}

function requiredInteger(object: Record<string, unknown>, field: string, label: string): number {
  const value = object[field];
  if (!Number.isInteger(value)) {
    throw new DesignTraceError("INVALID_PROJECT", `${label}.${field} must be an integer`);
  }
  return value as number;
}

export async function validateBaseline(reader: TreeReader): Promise<ValidatedBaseline> {
  const files = await reader.listFiles();
  for (const file of files) {
    if (file.mode === "120000" || file.mode === "160000") {
      throw new DesignTraceError(
        "UNSUPPORTED_RESOURCE",
        `Unsupported Git entry ${file.path} with mode ${file.mode}`,
      );
    }
    if (file.path.includes("\\") || file.path.startsWith("/") || file.path.split("/").includes("..")) {
      throw new DesignTraceError("INVALID_PROJECT", `Unsafe repository path: ${file.path}`);
    }
  }

  const project = parseYamlObject(await reader.readText("design/project.yaml"), "design/project.yaml");
  if (project.schema_version !== 1) {
    throw new DesignTraceError("INVALID_PROJECT", "Only project schema_version 1 is supported");
  }
  const projectId = requiredString(project, "project_id", "project");
  const pilotSystem = requiredString(project, "pilot_system", "project");
  const configPath = requiredString(project, "pilot_config", "project");
  if (!files.some((file) => file.path === configPath)) {
    throw new DesignTraceError("INVALID_PROJECT", `Pilot config does not exist: ${configPath}`);
  }

  const config = JSON.parse(await reader.readText(configPath)) as Record<string, unknown>;
  const normal = config.normal as Record<string, unknown> | undefined;
  const hard = config.hard as Record<string, unknown> | undefined;
  if (!normal || !hard) {
    throw new DesignTraceError("INVALID_PROJECT", "Pilot config must contain normal and hard objects");
  }
  const normalPenaltyBps = requiredInteger(normal, "penalty_bps", "config.normal");
  const hardPenaltyBps = requiredInteger(hard, "penalty_bps", "config.hard");

  const rulePaths = files.filter((file) => /^design\/rules\/[^/]+\.md$/u.test(file.path));
  const bindingPaths = files.filter((file) => /^design\/bindings\/[^/]+\.md$/u.test(file.path));
  if (rulePaths.length < 2 || bindingPaths.length < 2) {
    throw new DesignTraceError("INVALID_PROJECT", "Pilot baseline requires normal/hard Rules and Bindings");
  }

  const ids = new Set<string>();
  const rules = new Map<string, Record<string, unknown>>();
  const bindings: Record<string, unknown>[] = [];
  for (const file of [...rulePaths, ...bindingPaths]) {
    const object = parseFrontmatter(await reader.readText(file.path), file.path);
    if (object.schema_version !== 1) {
      throw new DesignTraceError("INVALID_PROJECT", `${file.path} must use schema_version 1`);
    }
    const id = requiredString(object, "id", file.path);
    if (ids.has(id)) {
      throw new DesignTraceError("INVALID_PROJECT", `Duplicate formal object ID: ${id}`);
    }
    ids.add(id);
    if (file.path.startsWith("design/rules/")) rules.set(id, object);
    else bindings.push(object);
  }

  for (const binding of bindings) {
    const ruleId = requiredString(binding, "rule_id", "binding");
    const rule = rules.get(ruleId);
    if (!rule) {
      throw new DesignTraceError("INVALID_PROJECT", `Binding references missing Rule: ${ruleId}`);
    }
    if (binding.path !== configPath || binding.value_type !== "integer" || binding.unit !== "bps") {
      throw new DesignTraceError("INVALID_PROJECT", `Binding ${String(binding.id)} is outside the pilot contract`);
    }
    const pointer = requiredString(binding, "pointer", "binding");
    const expected = pointer === "/normal/penalty_bps" ? normalPenaltyBps
      : pointer === "/hard/penalty_bps" ? hardPenaltyBps
      : undefined;
    if (expected === undefined) {
      throw new DesignTraceError("INVALID_PROJECT", `Unsupported pilot JSON pointer: ${pointer}`);
    }
    const parameters = rule.parameters as Record<string, unknown> | undefined;
    if (!parameters || parameters.penalty_bps !== expected) {
      throw new DesignTraceError(
        "INVALID_PROJECT",
        `Rule ${ruleId} does not match ${configPath}${pointer}`,
      );
    }
  }

  return { projectId, pilotSystem, configPath, normalPenaltyBps, hardPenaltyBps };
}
