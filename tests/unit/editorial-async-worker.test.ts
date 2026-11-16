import { expect, test } from "bun:test";
import { MySQLEditorialWorker } from "../../src/server/editorial/jobs/mysql-worker.js";
import type { MySQLEditorialJobRepository } from "../../src/server/editorial/jobs/mysql-repository.js";
import type { MySQLEditorialService } from "../../src/server/editorial/mysql-service.js";
import type { AsyncEditorialSources } from "../../src/server/editorial/async-ports.js";

test("an asynchronous editorial claim reserves its worker before yielding and releases the reservation on an empty queue", async () => {
  let finish!: (value: null) => void,
    claims = 0;
  const pending = new Promise<null>((resolve) => {
      finish = resolve;
    }),
    repository = {
      claim: async () => {
        claims++;
        return pending;
      },
    } as unknown as MySQLEditorialJobRepository,
    worker = new MySQLEditorialWorker(repository, {} as MySQLEditorialService, {} as AsyncEditorialSources, new Map());
  const first = worker.runOne();
  expect(await worker.runOne()).toBe(false);
  expect(claims).toBe(1);
  finish(null);
  expect(await first).toBe(false);
  expect(await worker.runOne()).toBe(false);
  expect(claims).toBe(2);
});
