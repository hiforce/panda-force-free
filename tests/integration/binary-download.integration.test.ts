import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import { respondBinaryDownload } from "../../src/server/http/binary-download.js";

test("binary downloads finish once and release pending delivery when a client disconnects", async () => {
  let deliveries = 0;
  let complete!: () => void;
  let started!: () => void;
  const completed = new Promise<void>((resolve) => {
      complete = resolve;
    }),
    requested = new Promise<void>((resolve) => {
      started = resolve;
    }),
    bytes = new Uint8Array(16 * 1024 * 1024),
    server = createServer((_req, res) => {
      void respondBinaryDownload(res, { filename: "公司主题.zip", bytes }, "application/zip").then(() => {
        deliveries++;
        complete();
      });
      started();
    });
  bytes[0] = 17;
  bytes[bytes.length - 1] = 239;
  let client: Socket | undefined;
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw Error("Missing fixture address");
    client = connect(address.port, "127.0.0.1");
    client.pause();
    await new Promise<void>((resolve, reject) => client!.once("connect", resolve).once("error", reject));
    client.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    await requested;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(deliveries).toBe(0);
    client.destroy();
    await completed;
    expect(deliveries).toBe(1);
    const response = await fetch(`http://127.0.0.1:${address.port}/`),
      received = new Uint8Array(await response.arrayBuffer());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain(encodeURIComponent("公司主题.zip"));
    expect(received.length).toBe(bytes.length);
    expect(received[0]).toBe(17);
    expect(received.at(-1)).toBe(239);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(deliveries).toBe(2);
  } finally {
    client?.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 5000);
