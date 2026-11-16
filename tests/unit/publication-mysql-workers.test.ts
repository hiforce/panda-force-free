import { expect, test } from "bun:test";
import type { MySQLPublicationRepository } from "../../src/server/delivery/mysql-repository.js";
import { MySQLPublicationWorker } from "../../src/server/delivery/mysql-worker.js";
import type { MySQLWorkflowRepository } from "../../src/server/delivery/storage/mysql-workflows.js";
import { MySQLWorkflowWorker } from "../../src/server/delivery/workflows/mysql-worker.js";

test("native workers release claims acquired during shutdown before authorizing or executing effects", async () => {
  for (const kind of ["site", "workflow"] as const) {
    let enter!: () => void,
      release!: () => void,
      executions = 0,
      released = 0;
    const entered = new Promise<void>((resolve) => {
        enter = resolve;
      }),
      held = new Promise<void>((resolve) => {
        release = resolve;
      }),
      lease = { id: "claim", owner: "worker", fence: 1, resumed: false, checkOnly: false, cleanup: false };
    const leases = {
      async acquire() {
        enter();
        await held;
        return lease;
      },
      async release(value: typeof lease) {
        expect(value).toEqual(lease);
        released++;
      },
    };
    const execute = async (): Promise<never> => {
      executions++;
      throw Error("stopped worker executed");
    };
    const worker =
      kind === "site"
        ? new MySQLPublicationWorker(
            {
              expire: async () => {},
              acquire: leases.acquire,
              releaseLease: leases.release,
            } as unknown as MySQLPublicationRepository,
            () => {
              throw Error("stopped worker created adapter");
            },
            execute,
            () => {},
          )
        : new MySQLWorkflowWorker(
            { leases } as unknown as MySQLWorkflowRepository,
            { authorize: execute, execute },
            () => {},
          );
    worker.wake();
    await entered;
    const stopping = worker.stop();
    release();
    await stopping;
    expect(released).toBe(1);
    expect(executions).toBe(0);
  }
});
