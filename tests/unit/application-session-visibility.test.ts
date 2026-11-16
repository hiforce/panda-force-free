import { expect, test } from "bun:test";
import { ProjectDirectoryPolicy } from "../../src/server/projects/directory-policy.js";
import {
  registerApplicationRoot,
  trackApplicationDirectory,
  rememberApplicationSession,
  isApplicationSession,
} from "../../src/server/engines/application-tools/sessions.js";

test("application threads stay out of ordinary sessions even before start binding and after scratch cleanup", async () => {
  const root = "/isolated/creation-visibility";
  registerApplicationRoot(root);
  const untrack = trackApplicationDirectory(root + "/run-current"),
    policy = new ProjectDirectoryPolicy("/isolated", true);
  policy.protectSessions(isApplicationSession);
  const thread = { id: "internal-current", cwd: root + "/run-current" },
    previous = { id: "internal-previous", cwd: root + "/run-previous" },
    normal = { id: "normal-coding", cwd: "/isolated/project" };
  expect(policy.remember(normal)).toBe(true);
  expect(policy.remember(thread)).toBe(false);
  untrack();
  expect(policy.remember(thread)).toBe(false);
  expect(policy.envelope({ method: "thread/started", params: { thread: previous } })).toBe(false);
  rememberApplicationSession("internal-known");
  const result: any = await policy.list(
    "thread/list",
    { data: [normal, thread, previous, { id: "internal-known" }] },
    async () => null,
  );
  expect(result.data).toEqual([normal]);
  await expect(
    policy.assertRequest("thread/resume", { threadId: thread.id }, {}, async () => thread),
  ).rejects.toThrow();
  await expect(
    policy.assertRequest("thread/read", { threadId: "unlisted-internal" }, {}, async () => ({
      id: "unlisted-internal",
      cwd: root + "/run-other",
    })),
  ).rejects.toThrow();
  expect(isApplicationSession("outside", { cwd: root + "-other/run" })).toBe(false);
});
