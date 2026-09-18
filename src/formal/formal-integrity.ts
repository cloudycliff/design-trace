import { digestObject, sha256 } from "../core/digest.js";
import { DesignTraceError } from "../core/errors.js";
import { validateChangePlan } from "../domain/change-plan.js";
import { loadFormalObjects } from "../domain/formal-objects.js";
import type { ReviewBundle } from "../domain/review-bundle.js";
import { parseFrontmatter } from "./frontmatter.js";
import { validateBaseline, type TreeReader } from "./project-validator.js";

interface RawTreeReader extends TreeReader {
  readRawText(path: string): Promise<string>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new DesignTraceError("INVALID_PROJECT", `${label} must be a non-empty string`);
  }
  return value;
}

export async function validateFormalTree(reader: RawTreeReader): Promise<void> {
  await validateBaseline(reader);
  await loadFormalObjects(reader);
  const files = await reader.listFiles();
  const ids = new Map<string, string>();
  for (const file of files.filter((entry) => /^design\/[^/]+\/[^/]+\.md$/u.test(entry.path))) {
    const object = parseFrontmatter(await reader.readText(file.path), file.path);
    if (object.schema_version !== 1) {
      throw new DesignTraceError("INVALID_PROJECT", `${file.path} must use schema_version 1`);
    }
    const id = requireString(object.id, `${file.path}.id`);
    const prior = ids.get(id);
    if (prior) throw new DesignTraceError("INVALID_PROJECT", `Duplicate formal object ID ${id}: ${prior}, ${file.path}`);
    ids.set(id, file.path);
    if (file.path.startsWith("design/changes/")) {
      if (object.status !== "applied") throw new DesignTraceError("INVALID_PROJECT", `${file.path} must be applied`);
      if (object.kind !== "bootstrap") {
        requireString(object.bundle_id, `${file.path}.bundle_id`);
        requireString(object.execution_snapshot_id, `${file.path}.execution_snapshot_id`);
        requireString(object.validation_batch_id, `${file.path}.validation_batch_id`);
      }
    }
  }

  const fileSet = new Set(files.map((file) => file.path));
  for (const file of files) {
    if (/^design\/plans\/[^/]+\.json$/u.test(file.path)) {
      validateChangePlan(JSON.parse(await reader.readText(file.path)) as unknown);
    } else if (/^design\/contexts\/[^/]+\.json$/u.test(file.path)) {
      const context = JSON.parse(await reader.readText(file.path)) as Record<string, unknown>;
      const contextDigest = requireString(context.context_digest, `${file.path}.context_digest`);
      const { context_digest: _digest, ...unsigned } = context;
      if (digestObject(unsigned) !== contextDigest) {
        throw new DesignTraceError("INTEGRITY_ERROR", `${file.path} context digest is invalid`);
      }
    } else if (/^design\/approvals\/[^/]+\.json$/u.test(file.path)) {
      const approval = JSON.parse(await reader.readText(file.path)) as Record<string, unknown>;
      requireString(approval.approval_id, `${file.path}.approval_id`);
      requireString(approval.change_id, `${file.path}.change_id`);
      requireString(approval.integrity_tag, `${file.path}.integrity_tag`);
      if (approval.stage !== "execution" && approval.stage !== "result") {
        throw new DesignTraceError("INVALID_PROJECT", `${file.path}.stage is invalid`);
      }
    } else if (/^design\/receipts\/[^/]+\.json$/u.test(file.path)) {
      const receipt = JSON.parse(await reader.readText(file.path)) as Record<string, unknown>;
      requireString(receipt.change_id, `${file.path}.change_id`);
      if (receipt.kind !== "bootstrap") {
        const bundle = receipt.review_bundle as ReviewBundle | undefined;
        if (!bundle) throw new DesignTraceError("INVALID_PROJECT", `${file.path} has no ReviewBundle`);
        const { review_digest: reviewDigest, ...unsigned } = bundle;
        if (digestObject(unsigned) !== reviewDigest || receipt.review_digest !== reviewDigest) {
          throw new DesignTraceError("INTEGRITY_ERROR", `${file.path} ReviewBundle digest is invalid`);
        }
        const approvalId = requireString(receipt.result_approval_id, `${file.path}.result_approval_id`);
        if (!fileSet.has(`design/approvals/${approvalId}.json`)) {
          throw new DesignTraceError("INVALID_PROJECT", `${file.path} references a missing result Approval`);
        }
      }
    } else {
      const artifact = /^design\/artifacts\/sha256\/([0-9a-f]{64})$/u.exec(file.path)?.[1];
      if (artifact && sha256(Buffer.from(await reader.readRawText(file.path), "utf8")) !== artifact) {
        throw new DesignTraceError("INTEGRITY_ERROR", `${file.path} content digest is invalid`);
      }
    }
  }
}
