import { resolve } from "node:path";
import { isRecord } from "../../../shared/records.js";
import type { CodexConnection, CodexTransportFactory } from "../codex-transport.js";

/** Verify the owned scratch directory before deleting a session; detached transports never stop the shared daemon. */
export async function forgetCodexApplicationSession(
  options: { connection: CodexConnection; scratchDirectory: string; version: string },
  sessionId: string,
  factory: CodexTransportFactory,
) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) throw new Error("Invalid application engine identity");
  let closing = false;
  const transport = factory({
    connection: options.connection,
    defaultCwd: options.scratchDirectory,
    clientInfo: { name: "panda-bot-chat-cleanup", title: "PandaForce Bot chat cleanup", version: options.version },
    isShuttingDown: () => closing,
    onConnected() {},
    onDisconnected() {},
    onMessage() {},
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        let current: unknown;
        try {
          current = await transport.request("thread/read", { threadId: sessionId, includeTurns: false });
        } catch (error) {
          const missing = (value: unknown) =>
            value instanceof Error &&
            /(?:(?:thread|conversation).*(?:not found|does not exist)|no rollout found for thread)/i.test(
              value.message,
            );
          if (missing(error)) return;
          if (!(error instanceof Error) || !/thread not loaded/i.test(error.message)) throw error;
          // An unloaded thread may still have a saved rollout. Resolve it without starting a turn;
          // only a confirmed absent rollout makes cleanup an idempotent success.
          try {
            current = await transport.request("thread/resume", { threadId: sessionId });
          } catch (resumeError) {
            if (missing(resumeError)) return;
            throw resumeError;
          }
        }
        if (
          !isRecord(current) ||
          !isRecord(current.thread) ||
          current.thread.id !== sessionId ||
          typeof current.thread.cwd !== "string" ||
          resolve(current.thread.cwd) !== resolve(options.scratchDirectory)
        )
          throw new Error("Application session ownership could not be verified");
        await transport.request("thread/delete", { threadId: sessionId });
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Application cleanup deadline exceeded")), 15000);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    closing = true;
    transport.cancelRestart();
    transport.rejectPending(new Error("Application cleanup closed"));
    transport.terminate();
  }
}
