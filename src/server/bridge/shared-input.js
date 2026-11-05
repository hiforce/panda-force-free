// Preparing input must not hydrate a journal for a thread the shared daemon
// already owns. turn/start and turn/steer still enforce native writer policy.
export async function prepareSharedInput({ request, getThreadMetadata }, params) {
  if (typeof params.threadId !== "string" || !params.threadId) throw new Error("Invalid thread id");
  let cursor;
  do {
    const page = await request("thread/loaded/list", { limit: 100, ...(cursor ? { cursor } : {}) });
    if (page.data?.includes(params.threadId)) {
      const thread = await getThreadMetadata(params.threadId);
      return { thread: { ...thread, canAcceptDirectInput: true }, pandaAlreadyLoaded: true };
    }
    cursor = page.nextCursor;
  } while (cursor);
  return request("thread/resume", { ...params, excludeTurns: true });
}

// Keep preparation and input on the same engine connection and browser request.
export async function submitPreparedInput(
  { request, getThreadMetadata, recordPrepared, markSubscribed },
  method,
  params,
) {
  if (!["turn/start", "turn/steer"].includes(method)) throw new Error("Unsupported prepared input operation");
  const prepared = await prepareSharedInput({ request, getThreadMetadata }, { threadId: params.threadId });
  recordPrepared(prepared);
  if (!prepared.pandaAlreadyLoaded) markSubscribed(params.threadId);
  return request(method, params);
}

// Queue/automatic recovery needs only the latest turn's status and error. A
// thread/read here would reintroduce a full journal scan after every queue poll.
export async function readSharedRecoveryState(request, threadId) {
  const result = await request("thread/turns/list", {
    threadId,
    limit: 1,
    sortDirection: "desc",
    itemsView: "summary",
  });
  if (!Array.isArray(result.data)) throw new Error("Shared thread state unavailable");
  return { thread: { id: threadId, turns: result.data } };
}
