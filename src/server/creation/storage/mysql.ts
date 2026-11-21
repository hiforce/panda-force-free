import type { SQL } from "bun";
import { createHash } from "node:crypto";
import type { CreationExecution } from "../contracts.js";
import { creationText } from "../validation.js";
import { MySQLCreationContext } from "./mysql-context.js";
import { MySQLCreationGoals } from "./mysql-goals.js";
import { MySQLCreationLeases } from "./mysql-leases.js";
import { MySQLCreationMessages } from "./mysql-messages.js";
import { MySQLCreationProgress } from "./mysql-progress.js";
import { MySQLCreationQuestions } from "./mysql-questions.js";
import { MySQLCreationTasks } from "./mysql-tasks.js";
export { creationLedgerNamespace } from "./mysql-context.js";

/** Public storage facade; all facets share one namespace and transaction context. */
export class MySQLCreationLedger {
  readonly namespace: string;
  readonly get: MySQLCreationTasks["get"];
  readonly find: MySQLCreationTasks["find"];
  readonly create: MySQLCreationTasks["create"];
  readonly cancel: MySQLCreationTasks["cancel"];
  readonly complete: MySQLCreationTasks["complete"];
  readonly notifications: MySQLCreationTasks["notifications"];
  readonly readNotification: MySQLCreationTasks["readNotification"];
  readonly outputFailure: MySQLCreationTasks["outputFailure"];
  readonly pending: MySQLCreationTasks["pending"];
  readonly retry: MySQLCreationTasks["retry"];
  readonly clearHistory: MySQLCreationTasks["clearHistory"];
  readonly list: MySQLCreationTasks["list"];
  readonly rounds: MySQLCreationTasks["rounds"];
  readonly nextOutput: MySQLCreationTasks["nextOutput"];
  readonly claim: MySQLCreationLeases["claim"];
  readonly bind: MySQLCreationLeases["bind"];
  readonly heartbeat: MySQLCreationLeases["heartbeat"];
  readonly assertExecution: MySQLCreationLeases["assertExecution"];
  readonly admit: MySQLCreationLeases["admit"];
  readonly claimNext: MySQLCreationLeases["claimNext"];
  readonly release: MySQLCreationLeases["release"];
  readonly fail: MySQLCreationLeases["fail"];
  readonly question: MySQLCreationQuestions["question"];
  readonly pendingQuestion: MySQLCreationQuestions["pendingQuestion"];
  readonly register: MySQLCreationQuestions["register"];
  readonly answer: MySQLCreationQuestions["answer"];
  readonly answered: MySQLCreationQuestions["answered"];
  readonly transaction: MySQLCreationContext["transaction"];
  readonly messages: MySQLCreationMessages["messages"];
  readonly goals: MySQLCreationGoals["goals"];
  readonly progress: MySQLCreationProgress["progress"];
  constructor(pool: SQL, namespace: string) {
    const context = new MySQLCreationContext(pool, namespace),
      tasks = new MySQLCreationTasks(context),
      leases: MySQLCreationLeases = new MySQLCreationLeases(context, tasks, () => goals.goals),
      goals: MySQLCreationGoals = new MySQLCreationGoals(context, tasks, leases),
      messages = new MySQLCreationMessages(context, tasks, leases),
      questions = new MySQLCreationQuestions(context, tasks, leases),
      progress = new MySQLCreationProgress(context, tasks);
    this.namespace = context.namespace;
    this.get = tasks.get.bind(tasks);
    this.find = tasks.find.bind(tasks);
    this.create = tasks.create.bind(tasks);
    this.cancel = tasks.cancel.bind(tasks);
    this.complete = tasks.complete.bind(tasks);
    this.notifications = tasks.notifications.bind(tasks);
    this.readNotification = tasks.readNotification.bind(tasks);
    this.outputFailure = tasks.outputFailure.bind(tasks);
    this.pending = tasks.pending.bind(tasks);
    this.retry = tasks.retry.bind(tasks);
    this.clearHistory = tasks.clearHistory.bind(tasks);
    this.list = tasks.list.bind(tasks);
    this.rounds = tasks.rounds.bind(tasks);
    this.nextOutput = tasks.nextOutput.bind(tasks);
    this.claim = leases.claim.bind(leases);
    this.bind = leases.bind.bind(leases);
    this.heartbeat = leases.heartbeat.bind(leases);
    this.assertExecution = leases.assertExecution.bind(leases);
    this.admit = leases.admit.bind(leases);
    this.claimNext = leases.claimNext.bind(leases);
    this.release = leases.release.bind(leases);
    this.fail = leases.fail.bind(leases);
    this.question = questions.question.bind(questions);
    this.pendingQuestion = questions.pendingQuestion.bind(questions);
    this.register = questions.register.bind(questions);
    this.answer = questions.answer.bind(questions);
    this.answered = questions.answered.bind(questions);
    this.transaction = context.transaction.bind(context);
    this.messages = messages.messages;
    this.goals = goals.goals;
    this.progress = progress.progress;
  }
  task(owner: string, id: string) {
    return this.get(owner, id);
  }
  async assert(scope: CreationExecution, now: number) {
    await this.assertExecution(scope, now);
  }
  get scheduling() {
    return {
      claim: this.claimNext.bind(this),
      release: this.release.bind(this),
      fail: this.fail.bind(this),
      nextOutput: this.nextOutput.bind(this),
      retry: this.retry.bind(this),
      clearHistory: this.clearHistory.bind(this),
      list: this.list.bind(this),
      rounds: this.rounds.bind(this),
    };
  }
  get questions() {
    return {
      task: this.task.bind(this),
      assert: this.assert.bind(this),
      register: this.register.bind(this),
      get: this.question.bind(this),
      pending: this.pendingQuestion.bind(this),
      answer: this.answer.bind(this),
      answered: this.answered.bind(this),
    };
  }
}
/** Matches PersonalContent's existing directory key, including empty personal ledgers. */
export function personalCreationLedgerNamespace(owner: string): string {
  return "personal:" + createHash("sha256").update(creationText(owner, 200)).digest("hex");
}
export function createMySQLCreationStorage(sql: SQL, namespace: string) {
  const tasks = new MySQLCreationLedger(sql, namespace);
  return {
    tasks,
    queue: tasks.scheduling,
    questions: tasks.questions,
    progress: tasks.progress,
    messages: tasks.messages,
    goals: tasks.goals,
  };
}
