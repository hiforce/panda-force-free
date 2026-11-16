export type DatabaseDriver = "sqlite" | "mysql";
export interface DatabaseTargetSummary {
  driver: DatabaseDriver;
  hostname?: string;
  port?: number;
  database?: string;
  tls?: "verify" | "disabled";
}
/** Passwords are write-only. A saved plan is addressed by its opaque id. */
export interface DatabaseConnectionInput {
  hostname: string;
  port: number;
  database: string;
  username: string;
  password: string;
  tls: { mode: "verify"; caFile?: string } | { mode: "disabled" };
  max?: number;
  connectionTimeout?: number;
  idleTimeout?: number;
}
export interface DatabaseIssue {
  code: string;
  module?: string;
  object?: string;
}
export type DatabaseOperationStage =
  "validate" | "schema" | "backup" | "copy" | "verify" | "activate" | "restart" | "complete" | "failed" | "canceled";
export interface DatabaseModuleProgress {
  module: string;
  stage: "pending" | "copy" | "verify" | "preserved" | "complete";
  rows: number;
  totalRows?: number;
}
export interface DatabaseOperation {
  id: string;
  status: "waiting-restart" | "running" | "complete" | "failed" | "canceled";
  stage: DatabaseOperationStage;
  source: DatabaseTargetSummary;
  target: DatabaseTargetSummary;
  modules: DatabaseModuleProgress[];
  startedAt: number;
  updatedAt: number;
  error?: DatabaseIssue;
  canRetry: boolean;
  canCancel: boolean;
}
export interface DatabaseOverview {
  schema: 1;
  administrator: boolean;
  initialChoiceRequired: boolean;
  current: DatabaseTargetSummary;
  bot?: { current: DatabaseTargetSummary; preservedOnMigration: boolean };
  readiness: {
    ready: boolean;
    modules: { module: string; schema: boolean; readWrite: boolean; importer: boolean }[];
    issues: DatabaseIssue[];
  };
  operation?: DatabaseOperation;
}
export interface DatabaseConnectionTest {
  ok: boolean;
  serverVersion?: string;
  strictMode?: boolean;
  issues: DatabaseIssue[];
}
export interface DatabaseMigrationPlan {
  id: string;
  source: DatabaseTargetSummary;
  target: DatabaseTargetSummary;
  restartRequired: true;
  ready: boolean;
  modules: {
    module: string;
    action: "copy" | "preserve";
    tableCount: number;
    rows?: number;
  }[];
  issues: DatabaseIssue[];
  expiresAt: number;
}
/** The client retains this token before submission so a lost response can be recovered after restart. */
export interface DatabaseMigrationRequest {
  planId: string;
  requestId: string;
  statusToken: string;
}
