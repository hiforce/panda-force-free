import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { withRequestErrors } from "../../src/server/http/request-handler.js";

test("unexpected HTTP failures return a safe error envelope without revealing server details", async () => {
  const server = createServer(
    withRequestErrors(async () => {
      throw new Error("Private internal credential details");
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw Error("Server did not bind");
    const response = await fetch(`http://127.0.0.1:${address.port}/example`);
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toEqual({ error: "Unexpected error", messageId: "errors.unexpectedError", messageArgs: {} });
  } finally {
    const closing = new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    server.closeAllConnections();
    await closing;
  }
});
