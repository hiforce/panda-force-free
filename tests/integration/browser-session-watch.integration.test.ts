import { test, expect } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { installBrowserConnections } from "../../src/server/bridge/browser-connections.js";
import type { PasswordAuth } from "../../src/server/auth/contracts.js";

for (const denied of [false, true])
  test(
    "asynchronous session watch " +
      (denied ? "rejects before engine access" : "retains the first message sent immediately after upgrade"),
    async () => {
      const server = createServer(),
        clients = new Set<WebSocket>();
      let requests = 0;
      const passwordAuth: PasswordAuth = {
        handle: async () => false,
        isAuthorized: async () => true,
        passwordSetupRequired: () => false,
        installationCode: () => null,
        close() {},
        watch: async () => {
          await Bun.sleep(30);
          if (denied) throw Error("Session authority unavailable");
          return () => {};
        },
      };
      const connections = installBrowserConnections({
        server,
        passwordAuth,
        clients,
        sseClients: new Set(),
        pendingEngineRequests: new Map(),
        idaasAuth: null,
        cluster: null,
        browserWire: {
          register() {},
          stringify(_client: unknown, value: unknown) {
            return JSON.stringify(value);
          },
        },
        projectVisibility: {
          snapshot() {
            return { revision: 0, hiddenProjects: {} };
          },
        },
        engineDriver: { connected: true },
        browseRoots: [],
        defaultCwd: "/",
        handleClient: async (client, message) => {
          requests++;
          client.send(JSON.stringify({ type: "echo", message }));
        },
      } as unknown as Parameters<typeof installBrowserConnections>[0]);
      let socket: WebSocket | undefined;
      try {
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const port = (server.address() as AddressInfo).port,
          messages: unknown[] = [];
        const result = await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => reject(Error("Session handshake did not settle")), 3000);
          socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
          socket.on("open", () => socket!.send(JSON.stringify({ id: "first-request", method: "thread/list" })));
          socket.on("message", (raw) => {
            const value = JSON.parse(String(raw));
            messages.push(value);
            if (value.type === "echo") {
              clearTimeout(timer);
              resolve("echo");
            }
          });
          socket.on("close", () => {
            if (denied) {
              clearTimeout(timer);
              resolve("closed");
            }
          });
          socket.on("error", () => {});
        });
        expect(result).toBe(denied ? "closed" : "echo");
        expect(requests).toBe(denied ? 0 : 1);
        if (denied) expect(messages).toEqual([]);
        else expect(messages).toContainEqual({ type: "echo", message: { id: "first-request", method: "thread/list" } });
      } finally {
        socket?.terminate();
        connections.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    5000,
  );
