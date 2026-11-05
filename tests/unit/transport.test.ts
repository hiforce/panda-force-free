import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import { createI18nRuntime } from "../../src/shared/i18n/runtime.js";
import { createTransport } from "../../src/client/transport.js";
import { deliveryIsUncertain } from "../../src/client/application/input-errors.js";
import { createStateFixture } from "../support/state-fixture.js";

const originalEventSource = globalThis.EventSource;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  jest.useFakeTimers();
  globalThis.EventSource = class {
    static CLOSED = 2;
    readyState = 0;
    close() {
      this.readyState = 2;
    }
  } as any;
});

afterEach(() => {
  jest.useRealTimers();
  mock.restore();
  globalThis.EventSource = originalEventSource;
  globalThis.fetch = originalFetch;
});

function fixture(transport = "ws") {
  const sent: any[] = [];
  class SocketResource {
    readyState = WebSocket.OPEN;
    onopen: unknown = null;
    onclose: unknown = null;
    onerror: unknown = null;
    onmessage: unknown = null;
    send(raw: string) {
      sent.push(JSON.parse(raw));
    }
    close = mock();
  }
  const socket = new SocketResource();
  const { state, mutations } = createStateFixture({
    transport,
    ws: transport === "ws" ? socket : null,
    events: null,
    rpcId: 1,
    pending: new Map(),
  });
  const onAuthCheck = mock();
  const api = createTransport({
    state,
    mutations,
    onMessage: () => {},
    setStatus: () => {},
    onAuthCheck,
    onSseDisrupted: () => {},
    onProjectVisibility: () => {},
    translate: createI18nRuntime({ preference: "en" }).t,
  });
  return { api, state, mutations, socket, sent, onAuthCheck };
}

describe("bridge request delivery deadlines", () => {
  test("a lost preparation reply times out and switches transport without submitting input", async () => {
    const f = fixture();
    const result = f.api.rpc("thread/resume", { threadId: "cli", pandaPrepareInput: true }).catch((error) => error);
    jest.advanceTimersByTime(45_000);
    expect(f.state.pending.size).toBe(0);
    expect((await result).message).toContain("timed out");
    expect(f.state.transport).toBe("sse");
    expect(f.socket.close).toHaveBeenCalledTimes(1);
    expect(f.sent.map((call) => call.method)).toEqual(["thread/resume"]);
  });

  test("a lost turn acknowledgement is never automatically sent again", async () => {
    const f = fixture();
    const result = f.api
      .rpc("turn/start", {
        threadId: "cli",
        input: [{ type: "text", text: "Run once" }],
      })
      .catch((error) => error);
    jest.advanceTimersByTime(90_000);
    expect(f.state.pending.size).toBe(0);
    expect((await result).message).toContain("timed out");
    expect(f.sent).toHaveLength(1);
    expect(f.state.pending.size).toBe(0);
  });

  test("successful replies clear their deadline and leave the socket connected", async () => {
    const f = fixture();
    const result = f.api.rpc("thread/resume", { threadId: "cli" });
    const id = f.sent[0].id;
    f.state.pending.get(id).resolve({ thread: { id: "cli" } });
    f.mutations.collection("pending").delete(id);
    expect(await result).toEqual({ thread: { id: "cli" } });
    jest.advanceTimersByTime(90_000);
    expect(f.state.transport).toBe("ws");
    expect(f.socket.close).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  test("SSE requests also time out when the HTTP reply stalls", async () => {
    const f = fixture("sse");
    let signal: AbortSignal;
    const fetchMock = mock((_url, options) => {
      signal = options.signal;
      return new Promise((_resolve, reject) =>
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
    });
    globalThis.fetch = fetchMock as any;
    const result = f.api.rpc("turn/start", { threadId: "cli" }).catch((error) => error);
    jest.advanceTimersByTime(45_000);
    expect(signal?.aborted).toBe(true);
    expect((await result).message).toContain("timed out");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe("HTTP bridge connection failures", () => {
  test("a temporary input-preparation failure recovers without submitting user input", async () => {
    const f = fixture("sse");
    const fetchMock = mock()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(
        Response.json({
          type: "rpc/result",
          result: { thread: { id: "cli" } },
        }),
      );
    globalThis.fetch = fetchMock as any;
    expect(
      await f.api.rpc("thread/resume", {
        threadId: "cli",
        pandaPrepareInput: true,
      }),
    ).toEqual({ thread: { id: "cli" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([, options]) => JSON.parse(options.body).method)).toEqual([
      "thread/resume",
      "thread/resume",
    ]);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("persistent preparation failures are bounded and identify the failed operation", async () => {
    const f = fixture("sse"),
      cause = new TypeError("Failed to fetch");
    const fetchMock = mock(() => Promise.reject(cause));
    globalThis.fetch = fetchMock as any;
    const error = await f.api
      .rpc("thread/resume", { threadId: "cli", pandaPrepareInput: true })
      .catch((error) => error);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(error.code).toBe("bridge_network_error");
    expect(error.operation).toBe("thread/resume");
    expect(error.cause).toBe(cause);
    expect(error.message).not.toBe("Failed to fetch");
    expect(deliveryIsUncertain(error, false)).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  test.each(["turn/start", "turn/steer", "thread/start", "thread/queue/add", "thread/resume"])(
    "a failed %s request is never replayed automatically",
    async (method) => {
      const f = fixture("sse"),
        fetchMock = mock(() => Promise.reject(new TypeError("Failed to fetch")));
      globalThis.fetch = fetchMock as any;
      const error = await f.api.rpc(method, { threadId: "cli" }).catch((error) => error);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(error.code).toBe("bridge_network_error");
      expect(deliveryIsUncertain(error, true)).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  test("an unreadable successful response leaves dispatched input unconfirmed", async () => {
    const f = fixture("sse"),
      fetchMock = mock(() => Promise.resolve(new Response("<html>Proxy response</html>")));
    globalThis.fetch = fetchMock as any;
    const error = await f.api.rpc("turn/start", {}).catch((error) => error);
    expect(error.code).toBe("bridge_invalid_response");
    expect(deliveryIsUncertain(error, true)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("an HTTP authentication rejection checks sign-in without replaying input", async () => {
    const f = fixture("sse"),
      fetchMock = mock(() => Promise.resolve(Response.json({ error: "Sign in required" }, { status: 401 })));
    globalThis.fetch = fetchMock as any;
    const error = await f.api.rpc("turn/start", {}).catch((error) => error);
    expect(error.status).toBe(401);
    expect(f.onAuthCheck).toHaveBeenCalledTimes(1);
    expect(deliveryIsUncertain(error, true)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a gateway error cannot prove that dispatched input was rejected", async () => {
    const f = fixture("sse"),
      fetchMock = mock(() => Promise.resolve(new Response("Bad Gateway", { status: 502 })));
    globalThis.fetch = fetchMock as any;
    const error = await f.api.rpc("turn/start", {}).catch((error) => error);
    expect(error.status).toBe(502);
    expect(deliveryIsUncertain(error, true)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("native provider errors stay verbatim and are never treated as browser failures", async () => {
    const f = fixture("sse"),
      fetchMock = mock(() =>
        Promise.resolve(
          Response.json({
            type: "rpc/error",
            error: "Failed to fetch",
            code: "codex_error",
          }),
        ),
      );
    globalThis.fetch = fetchMock as any;
    const error = await f.api.rpc("thread/resume", { pandaPrepareInput: true }).catch((error) => error);
    expect(error.message).toBe("Failed to fetch");
    expect(error.code).toBe("codex_error");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
