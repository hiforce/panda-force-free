import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createBrowserFixture, artifacts, root } from "../support/browser-runtime.mjs";

const temporary = mkdtempSync(join(artifacts, "cache-boundary-"));
const entry = join(temporary, "entry.js");
writeFileSync(
  entry,
  `export {createConversationCache} from ${JSON.stringify(join(root, "src/client/conversation-cache.js"))};`,
);
const build = await Bun.build({ entrypoints: [entry], target: "browser", format: "esm" });
assert.equal(build.success, true, "Cache test module must build");
const bundle = await build.outputs[0].text();
const fixture = await createBrowserFixture();
try {
  const browser = await fixture.launchBrowser();
  const page = await browser.newPage();
  await page.route("**/cache-boundary.js", (route) => route.fulfill({ contentType: "text/javascript", body: bundle }));
  await page.goto(fixture.base);
  await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
  const result = await page.evaluate(async () => {
    const { createConversationCache } = await import("/cache-boundary.js");
    const suffix = crypto.randomUUID();
    const first = createConversationCache({ identity: "alpha-" + suffix });
    const second = createConversationCache({ identity: "beta-" + suffix });
    const thread = { id: "same-id", turns: [], updatedAt: Date.now() / 1000 };
    await first.put({ ...thread, name: "First identity" });
    await second.put({ ...thread, name: "Second identity" });
    globalThis.__pandaForceIdentityKey = "another-identity";
    const firstName = (await first.get(thread.id))?.name;
    const secondName = (await second.get(thread.id))?.name;
    let anonymousOpens = 0;
    const anonymous = createConversationCache({
      indexedDB: {
        open() {
          anonymousOpens++;
          throw Error("Must not open anonymously");
        },
      },
    });
    await anonymous.put(thread);
    await anonymous.get(thread.id);
    const closingRead = first.get(thread.id);
    first.close();
    const disposedRead = await closingRead;
    const disposedWrite = await first.put(thread);
    let attempts = 0;
    const retry = createConversationCache({
      identity: "retry-" + suffix,
      indexedDB: {
        open(...args) {
          if (++attempts === 1) throw Error("Temporary failure");
          return indexedDB.open(...args);
        },
      },
    });
    await retry.get(thread.id);
    const recovered = await retry.put({ ...thread, name: "Recovered" });
    const recoveredName = (await retry.get(thread.id))?.name;
    const latestRead = second.get(thread.id);
    await second.clear();
    const afterClear = await second.get(thread.id);
    await latestRead;
    second.close();
    retry.close();
    anonymous.close();
    return {
      firstName,
      secondName,
      anonymousOpens,
      disposedRead,
      disposedWrite: disposedWrite ?? null,
      attempts,
      recovered,
      recoveredName,
      afterClear,
    };
  });
  assert.equal(result.firstName, "First identity", "Changing a global cannot retarget an existing cache");
  assert.equal(result.secondName, "Second identity", "Identical conversation IDs must stay isolated by user");
  assert.equal(result.anonymousOpens, 0, "Unidentified users must not open a shared fallback database");
  assert.equal(result.disposedRead, null, "Disposed owners must not receive late cached records");
  assert.equal(result.disposedWrite, null, "Disposed owners cannot write new cache records");
  assert.equal(result.attempts, 2, "A temporary database failure must not poison all subsequent reads");
  assert.equal(result.recovered, true);
  assert.equal(result.recoveredName, "Recovered");
  assert.equal(result.afterClear, null, "Logout cleanup must remove persisted content before returning");
  console.log("Cache identity, disposal, transient recovery and clear boundaries passed.");
} finally {
  await fixture.dispose();
  rmSync(temporary, { recursive: true, force: true });
}
