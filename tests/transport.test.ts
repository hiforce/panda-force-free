import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import { createTransport } from "../src/client/transport.js";

const originalEventSource = globalThis.EventSource;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  jest.useFakeTimers();
  globalThis.EventSource = class {
    static CLOSED = 2;
    readyState = 0;
    close() { this.readyState = 2; }
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
  const socket = { readyState: WebSocket.OPEN, send: (raw: string) => sent.push(JSON.parse(raw)), close: mock() };
  const state: any = { transport, ws: transport === "ws" ? socket : null, events: null, rpcId: 1, pending: new Map() };
  const api = createTransport({
    state, onMessage: () => {}, setStatus: () => {}, onAuthCheck: () => {},
    onSseDisrupted: () => {}, onProjectVisibility: () => {}, translate: (text: string) => text,
  });
  return { api, state, socket, sent };
}

describe("bridge request delivery deadlines", () => {
  test("a lost preparation reply times out and switches transport without submitting input", async () => {
    const f = fixture();
    const result = f.api.rpc("thread/resume", { threadId: "cli", webuiPrepareInput: true }).catch(error => error);
    jest.advanceTimersByTime(45_000);
    expect(f.state.pending.size).toBe(0);
    expect((await result).message).toContain("timed out");
    expect(f.state.transport).toBe("sse");
    expect(f.socket.close).toHaveBeenCalledTimes(1);
    expect(f.sent.map(call => call.method)).toEqual(["thread/resume"]);
  });

  test("a lost turn acknowledgement is never automatically sent again", async () => {
    const f = fixture();
    const result = f.api.rpc("turn/start", { threadId: "cli", input: [{ type: "text", text: "Run once" }] })
      .catch(error => error);
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
    f.state.pending.delete(id);
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
      return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    globalThis.fetch = fetchMock as any;
    const result = f.api.rpc("turn/start", { threadId: "cli" }).catch(error => error);
    jest.advanceTimersByTime(45_000);
    expect(signal?.aborted).toBe(true);
    expect((await result).message).toContain("timed out");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});
