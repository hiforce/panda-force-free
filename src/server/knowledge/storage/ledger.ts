import type { Database } from "bun:sqlite";
import type { KnowledgeTaskStore } from "../tasks/contracts.js";
import { KnowledgeTaskRecords } from "./records.js";
import { KnowledgeTaskSubmissionsStore } from "./submissions.js";
import { KnowledgeTaskExecutions } from "./executions.js";
import { KnowledgeTaskReviews } from "./reviews.js";
import { KnowledgeTaskDelivery } from "./delivery.js";

/** Assembly has no transition logic; domain use cases receive narrow storage facets. */
export function knowledgeTaskLedger(db: Database): KnowledgeTaskStore {
  const records = new KnowledgeTaskRecords(db),
    submissions = new KnowledgeTaskSubmissionsStore(db, records),
    executions = new KnowledgeTaskExecutions(db, records),
    reviews = new KnowledgeTaskReviews(db, records, executions),
    delivery = new KnowledgeTaskDelivery(db, records);
  return {
    get: records.get.bind(records),
    list: records.list.bind(records),
    page: records.page.bind(records),
    submission: records.submission.bind(records),
    create: submissions.create.bind(submissions),
    claim: executions.claim.bind(executions),
    assertLease: executions.assertLease.bind(executions),
    assertExecution: executions.assertExecution.bind(executions),
    bind: executions.bind.bind(executions),
    heartbeat: executions.heartbeat.bind(executions),
    fail: executions.fail.bind(executions),
    release: executions.release.bind(executions),
    retry: executions.retry.bind(executions),
    question: reviews.question.bind(reviews),
    draft: reviews.draft.bind(reviews),
    answer: reviews.answer.bind(reviews),
    edit: reviews.edit.bind(reviews),
    admit: reviews.admit.bind(reviews),
    cancel: reviews.cancel.bind(reviews),
    complete: delivery.complete.bind(delivery),
    denyDelivery: delivery.denyDelivery.bind(delivery),
    outputFailed: delivery.outputFailed.bind(delivery),
    retryOutput: delivery.retryOutput.bind(delivery),
    nextOutput: delivery.nextOutput.bind(delivery),
    rejectDelivery: delivery.rejectDelivery.bind(delivery),
  };
}
