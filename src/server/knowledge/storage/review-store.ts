import type { Database } from "bun:sqlite";
import type { KnowledgeReviewStore } from "../review/contracts.js";
import { KnowledgeTaskRecords } from "./records.js";
import { KnowledgeReviewPoliciesStore } from "./review-policies.js";
import { KnowledgeReviewExecutionsStore } from "./review-executions.js";
import { KnowledgeReviewDecisionsStore } from "./review-decisions.js";

export function knowledgeReviewStore(db: Database): KnowledgeReviewStore {
  const policies = new KnowledgeReviewPoliciesStore(db),
    execution = new KnowledgeReviewExecutionsStore(db, new KnowledgeTaskRecords(db)),
    decisions = new KnowledgeReviewDecisionsStore(db);
  return {
    policy: policies.policy.bind(policies),
    configure: policies.configure.bind(policies),
    claim: execution.claim.bind(execution),
    assert: execution.assert.bind(execution),
    bind: execution.bind.bind(execution),
    heartbeat: execution.heartbeat.bind(execution),
    fail: execution.fail.bind(execution),
    latest: decisions.latest.bind(decisions),
    latestFor: decisions.latestFor.bind(decisions),
    finish: decisions.finish.bind(decisions),
    admit: decisions.admit.bind(decisions),
    pending: decisions.pending.bind(decisions),
  };
}
