import { CliError, cliObject } from "../shared/cli/contracts.js";

export async function creationCallback(value: unknown) {
  const { endpoint, authorization, requestId } = cliObject(value, ["endpoint", "authorization", "requestId"]);
  if (
    typeof endpoint !== "string" ||
    !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/creation-callback$/.test(endpoint) ||
    typeof authorization !== "string" ||
    !/^Bearer [a-f0-9]{64}$/.test(authorization) ||
    typeof requestId !== "string" ||
    !/^[a-f0-9-]{36}$/.test(requestId)
  )
    throw new CliError("invalidInput");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ requestId }),
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  if (response.status !== 202 || !response.body) throw new CliError("unavailable", 503);
  const reader = response.body.getReader();
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      body += Buffer.from(value).toString();
      if (body.length > 1024) throw new CliError("limit", 413);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const result = cliObject(JSON.parse(body), ["requestId", "accepted"]);
  if (result.requestId !== requestId || result.accepted !== true) throw new CliError("unavailable", 503);
  return result;
}
