import { parseDocument } from "yaml";
import { DesignTraceError } from "../core/errors.js";

export function parseFrontmatter(source: string, label: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(source);
  if (!match?.[1]) {
    throw new DesignTraceError("INVALID_PROJECT", `${label} must start with YAML frontmatter`);
  }

  const document = parseDocument(match[1], {
    schema: "core",
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new DesignTraceError(
      "INVALID_PROJECT",
      `${label} has invalid YAML: ${document.errors.map((error) => error.message).join("; ")}`,
    );
  }
  const value = document.toJS({ maxAliasCount: 0 }) as unknown;
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new DesignTraceError("INVALID_PROJECT", `${label} frontmatter must be an object`);
  }
  return value as Record<string, unknown>;
}

export function parseYamlObject(source: string, label: string): Record<string, unknown> {
  const document = parseDocument(source, {
    schema: "core",
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new DesignTraceError(
      "INVALID_PROJECT",
      `${label} has invalid YAML: ${document.errors.map((error) => error.message).join("; ")}`,
    );
  }
  const value = document.toJS({ maxAliasCount: 0 }) as unknown;
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new DesignTraceError("INVALID_PROJECT", `${label} must contain an object`);
  }
  return value as Record<string, unknown>;
}
