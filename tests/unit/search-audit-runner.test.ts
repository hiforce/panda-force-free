import { expect, test } from "bun:test";
import { SearchAuditRunner } from "../../src/server/search/audit/runner.js";
import { SearchError } from "../../src/shared/search/contracts.js";
import { searchAuditFixture } from "../support/search-audit-fixture.js";

async function until(check: () => boolean) {
  const deadline = Date.now() + 2500;
  while (!check()) {
    if (Date.now() > deadline) throw Error("Audit runner did not settle");
    await Bun.sleep(10);
  }
}
test("coalesced background audits keep local progress independent from a stalled external slot", async () => {
  const f = searchAuditFixture(),
    local = f.add(),
    external = f.add("external"),
    original = f.ports.runtime.text,
    calls = { local: 0, elasticsearch: 0 },
    errors: unknown[] = [];
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.ports.runtime.text = (source) => ({
    ...original(source),
    audit: async () => {
      calls[source.kind]++;
      if (source.kind === "elasticsearch") await held;
      return { count: 1, checks: ["bytes"] };
    },
  });
  const runner = new SearchAuditRunner(
    f.ports,
    f.audits,
    () => {
      throw Error("Healthy generations cannot rebuild");
    },
    (error) => errors.push(error),
  );
  try {
    runner.start();
    for (let i = 0; i < 100; i++) runner.kick();
    await until(() => !!f.audits.view(f.jobs.get(local), 1).latest && calls.elasticsearch > 0);
    expect(f.audits.view(f.jobs.get(local), 1).latest?.status).toBe("healthy");
    expect(f.audits.view(f.jobs.get(external), 1).running).toBeTrue();
    expect(calls).toEqual({ local: 1, elasticsearch: 1 });
    release();
    await until(() => !!f.audits.view(f.jobs.get(external), 1).latest);
    expect(errors).toEqual([]);
  } finally {
    release();
    await runner.close();
    f.db.close();
  }
});
test("an external outage backs off shared provider work without blocking the local source", async () => {
  const f = searchAuditFixture(),
    local = f.add(),
    external = f.add("external"),
    second = f.add("external", "another-project"),
    original = f.ports.runtime.text;
  let externalCalls = 0;
  f.ports.runtime.text = (source) => ({
    ...original(source),
    fingerprint: () => source.kind,
    audit: async () => {
      if (source.kind === "elasticsearch") {
        externalCalls++;
        throw new SearchError("unavailable", 503);
      }
      return { count: 1, checks: ["bytes"] };
    },
  });
  for (const scope of [local, external, second]) {
    const row = f.jobs.get(scope)!;
    f.jobs.wake(row.key);
    f.jobs.complete(
      f.jobs.claim([scope.source])!,
      { ...f.jobs.active(row)!, textFingerprint: f.sources.get(scope.source).kind },
      "saved",
      1,
    );
  }
  const runner = new SearchAuditRunner(
    f.ports,
    f.audits,
    () => {
      throw Error("Outages cannot rebuild");
    },
    () => {},
  );
  try {
    runner.start();
    await until(() => !!f.audits.view(f.jobs.get(external), 1).latest && !!f.audits.view(f.jobs.get(local), 1).latest);
    expect(f.audits.view(f.jobs.get(local), 1).latest?.status).toBe("healthy");
    expect(f.audits.view(f.jobs.get(external), 1).latest).toMatchObject({ status: "unavailable", repairQueued: false });
    expect(f.audits.view(f.jobs.get(second), 1).latest).toBeNull();
    runner.kick();
    await Bun.sleep(30);
    expect(externalCalls).toBe(1);
    expect(f.jobs.get(external)?.state).toBe("ready");
  } finally {
    await runner.close();
    f.db.close();
  }
});
test("closing the runner cancels in-flight audits without invalidating the active generation", async () => {
  const f = searchAuditFixture(),
    scope = f.add(),
    before = f.jobs.get(scope)!;
  let entered = false;
  f.provider.audit = async (_ref, _analyzer, signal) => {
    entered = true;
    await new Promise<void>((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
    );
    throw Error("Aborted work cannot continue");
  };
  const runner = new SearchAuditRunner(
    f.ports,
    f.audits,
    () => {
      throw Error("Cancellation cannot rebuild");
    },
    () => {},
  );
  try {
    runner.start();
    await until(() => entered);
    await runner.close();
    expect(f.audits.view(f.jobs.get(scope), 1).latest).toMatchObject({ status: "unavailable", repairQueued: false });
    expect(f.jobs.get(scope)).toEqual(before);
  } finally {
    await runner.close();
    f.db.close();
  }
});
