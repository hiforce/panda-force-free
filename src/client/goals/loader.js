import { reportDiagnostic } from "../../shared/diagnostics.js";

/** A snapshot cannot overwrite a notification received while its read was in flight. */
export function createGoalLoader({ rpc, apply, clear }) {
  const requests = new Map();
  return {
    changed(threadId) {
      const request = requests.get(threadId);
      if (request) request.stale = true;
    },
    load(threadId) {
      if (!threadId) return Promise.resolve();
      const existing = requests.get(threadId);
      if (existing) return existing.promise;
      const request = { stale: false, promise: Promise.resolve() };
      request.promise = Promise.resolve().then(async () => {
        try {
          const result = await rpc("thread/goal/get", { threadId });
          if (request.stale || result?.goal === undefined) return;
          if (result.goal === null) clear(threadId);
          else if (
            typeof result.goal === "object" &&
            typeof result.goal.objective === "string" &&
            typeof result.goal.status === "string" &&
            (!result.goal.threadId || result.goal.threadId === threadId)
          )
            apply("thread/goal/updated", { threadId, goal: result.goal });
        } catch (error) {
          reportDiagnostic("goal-snapshot", error);
        } finally {
          if (requests.get(threadId) === request) requests.delete(threadId);
        }
      });
      requests.set(threadId, request);
      return request.promise;
    },
  };
}
