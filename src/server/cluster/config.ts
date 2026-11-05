export interface ClusterConfig {
  role: "worker" | "gateway";
  workspace: string;
  nodeId: string;
  databaseUrl: string;
  secret: string;
  publicUrl: string;
  nodeUrl: string | null;
  leaseMs: number;
  requestTimeoutMs: number;
  recoverFence: number | null;
}
const identity = (value: string | undefined, name: string) => {
  if (!value || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value)) throw new Error(name + " must be a stable identity");
  return value;
};
function origin(value: string | undefined, name: string) {
  if (!value) throw new Error(name + " is required in cluster mode");
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("Invalid " + name);
  return url.origin;
}
/** Cluster mode is explicit; an incomplete shared setup never becomes a local silo. */
export function readClusterConfig(env: NodeJS.ProcessEnv = process.env): ClusterConfig | null {
  const role = env.PANDA_FORCE_CLUSTER_ROLE;
  if (!role || role === "standalone") {
    if (
      Object.keys(env).some(
        (name) => name.startsWith("PANDA_FORCE_CLUSTER_") && name !== "PANDA_FORCE_CLUSTER_ROLE" && env[name],
      )
    )
      throw new Error("Set PANDA_FORCE_CLUSTER_ROLE when configuring a cluster");
    return null;
  }
  if (role !== "worker" && role !== "gateway") throw new Error("Invalid PANDA_FORCE_CLUSTER_ROLE");
  const databaseUrl = env.PANDA_FORCE_CLUSTER_DATABASE_URL;
  let databaseProtocol: string | undefined;
  try {
    databaseProtocol = databaseUrl ? new URL(databaseUrl).protocol : undefined;
  } catch {
    /* Report configuration names without logging credentials. */
  }
  if (!databaseUrl || !databaseProtocol || !["postgres:", "postgresql:"].includes(databaseProtocol))
    throw new Error("Cluster coordination requires a PostgreSQL URL");
  const secret = env.PANDA_FORCE_CLUSTER_SECRET;
  if (!secret || secret.length < 32 || /CHANGE_ME/i.test(secret))
    throw new Error("Cluster signing secret must contain at least 32 characters");
  const leaseMs = Number(env.PANDA_FORCE_CLUSTER_LEASE_MS || 30_000);
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 6000 || leaseMs > 300_000)
    throw new Error("Invalid cluster lease duration");
  if (role === "worker" && env.PANDA_FORCE_CLUSTER_STORAGE !== "owner-volume")
    throw new Error("Worker storage must be an exclusive persistent owner volume");
  const recovery = env.PANDA_FORCE_CLUSTER_RECOVER_FENCE;
  const recoverFence = recovery === undefined ? null : Number(recovery);
  if (recoverFence !== null && (!Number.isSafeInteger(recoverFence) || recoverFence < 1))
    throw new Error("Invalid recovery fence");
  return {
    role,
    workspace: identity(env.PANDA_FORCE_CLUSTER_WORKSPACE, "PANDA_FORCE_CLUSTER_WORKSPACE"),
    nodeId: identity(env.PANDA_FORCE_CLUSTER_NODE_ID, "PANDA_FORCE_CLUSTER_NODE_ID"),
    databaseUrl,
    secret,
    leaseMs,
    publicUrl: origin(env.PANDA_FORCE_PUBLIC_URL, "PANDA_FORCE_PUBLIC_URL"),
    nodeUrl: role === "worker" ? origin(env.PANDA_FORCE_CLUSTER_NODE_URL, "PANDA_FORCE_CLUSTER_NODE_URL") : null,
    requestTimeoutMs: 120_000,
    recoverFence,
  };
}
