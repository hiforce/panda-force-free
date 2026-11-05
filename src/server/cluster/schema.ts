export const CLUSTER_SCHEMA = `
CREATE TABLE IF NOT EXISTS panda_workspace_owners (
  workspace TEXT PRIMARY KEY, node_id TEXT NOT NULL, boot_id TEXT NOT NULL,
  address TEXT NOT NULL, fence BIGINT NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
  released BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE IF NOT EXISTS panda_cluster_events (
  sequence BIGSERIAL PRIMARY KEY, workspace TEXT NOT NULL, fence BIGINT NOT NULL,
  data JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS panda_events_workspace ON panda_cluster_events(workspace, fence, sequence);
CREATE INDEX IF NOT EXISTS panda_events_retention ON panda_cluster_events(workspace, created_at);
CREATE TABLE IF NOT EXISTS panda_cluster_operations (
  workspace TEXT NOT NULL, operation_id TEXT NOT NULL, digest TEXT NOT NULL,
  fence BIGINT NOT NULL, state TEXT NOT NULL CHECK(state IN ('running', 'completed', 'uncertain')),
  result JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace, operation_id)
);
CREATE INDEX IF NOT EXISTS panda_operations_retention ON panda_cluster_operations(workspace, created_at) WHERE state='completed';
CREATE TABLE IF NOT EXISTS panda_cluster_nonces (
  workspace TEXT NOT NULL, nonce TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(workspace, nonce)
);
CREATE INDEX IF NOT EXISTS panda_nonces_retention ON panda_cluster_nonces(workspace, expires_at);
`;
