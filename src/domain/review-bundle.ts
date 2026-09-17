export interface ReviewBundle {
  schema_version: 1;
  bundle_id: string;
  change_id: string;
  plan_revision: number;
  baseline_commit: string;
  execution_snapshot_id: string;
  execution_tree_oid: string;
  payload_commit: string;
  payload_tree_oid: string;
  validation_batch_id: string;
  validation_run_ids: string[];
  plan_digest: string;
  context_digest: string;
  impact_digest: string;
  policy_digest: string;
  policy_version: number;
  execution_approval_id: string;
  changed_paths: string[];
  changed_pointers: Array<{ path: string; pointer: string; before: unknown; after: unknown }>;
  built_at: string;
  review_digest: string;
}

export interface PublishedChange {
  change_id: string;
  bundle_id: string;
  commit: string;
  parent_commit: string;
  payload_tree_oid: string;
  review_digest: string;
  result_approval_id: string;
  status: "applied";
}
