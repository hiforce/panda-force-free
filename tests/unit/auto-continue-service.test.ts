import { describe, expect, test } from "bun:test";
import { createAutoContinueRecovery } from "../../src/server/bridge/auto-continue.js";

const failure = (id: string) => ({
  id,
  status: "failed",
  error: {
    message: "Selected model is at capacity. Please try a different model.",
    codexErrorInfo: "serverOverloaded",
  },
});

function fixture({ enabled = true, own = true } = {}) {
  const timers: any[] = [],
    calls: any[] = [],
    errors: any[] = [];
  let snapshot: any = { thread: { id: "cli", status: { type: "idle" }, turns: [failure("original")] } };
  let read: any = () => snapshot;
  let start: any = null;
  let clock = 0;
  const recovery = createAutoContinueRecovery(
    async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === "thread/read") return read(params);
      if (start) return start(params);
      return { turn: { id: `retry-${calls.filter((c) => c.method === "turn/start").length}` } };
    },
    (error) => errors.push(error),
    {
      enabled,
      now: () => clock,
      random: () => 0,
      schedule: (callback: any, delay: number) => {
        const timer = { callback, delay, cancelled: false };
        timers.push(timer);
        return timer;
      },
      cancel: (timer: any) => {
        timer.cancelled = true;
      },
    },
  );
  if (own) {
    const claim = recovery.onExplicitInput("cli");
    recovery.onSubmitted("cli", "original", claim);
  }
  const notify = (method: string, turn: any) => recovery.onNotification({ method, params: { threadId: "cli", turn } });
  const starts = () => calls.filter((c) => c.method === "turn/start");
  const flush = async () => {
    const timer = timers.shift();
    if (timer && !timer.cancelled) {
      clock += timer.delay;
      await timer.callback();
    }
  };
  return {
    recovery,
    timers,
    calls,
    errors,
    notify,
    starts,
    flush,
    snapshot: (value: any) => {
      snapshot = value;
    },
    read: (value: any) => {
      read = value;
    },
    advance: (ms: number) => {
      clock += ms;
    },
    own: (id: string) => {
      const claim = recovery.onExplicitInput("cli");
      recovery.onSubmitted("cli", id, claim);
    },
    start: (handler: any) => {
      start = handler;
    },
  };
}

describe("automatic Continue after terminal capacity failures", () => {
  test("additional continuation is disabled unless explicitly enabled", () => {
    const calls: unknown[] = [];
    const recovery = createAutoContinueRecovery(
      async () => {
        calls.push("request");
      },
      undefined,
      {
        schedule: () => {
          calls.push("timer");
          return 1 as any;
        },
      },
    );
    const claim = recovery.onExplicitInput("cli");
    recovery.onSubmitted("cli", "original", claim);
    recovery.onNotification({ method: "turn/started", params: { threadId: "cli", turn: { id: "original" } } });
    recovery.onNotification({ method: "turn/completed", params: { threadId: "cli", turn: failure("original") } });
    expect(calls).toHaveLength(0);
  });
  test("owned turn errors do not recover until the failed terminal event arrives", async () => {
    const f = fixture();
    f.notify("turn/started", { id: "original", status: "inProgress" });
    f.recovery.onNotification({
      method: "error",
      params: { threadId: "cli", turnId: "original", error: failure("original").error },
    });
    f.notify("turn/completed", { ...failure("original"), status: "inProgress" });
    expect(f.timers).toHaveLength(0);
    f.notify("turn/completed", failure("original"));
    await f.flush();
    expect(f.calls.map((c) => c.method)).toEqual(["thread/read", "turn/start"]);
    expect(f.starts()[0].params.threadId).toBe("cli");
    expect(f.starts()[0].params.input[0].text).toContain("only unfinished work");
  });

  test("duplicates of a failed turn schedule only one recovery", async () => {
    const f = fixture();
    f.notify("turn/started", { id: "original", status: "inProgress" });
    f.notify("turn/completed", failure("original"));
    f.notify("turn/completed", failure("original"));
    await f.flush();
    f.notify("turn/completed", failure("original"));
    expect(f.starts()).toHaveLength(1);
    expect(f.timers).toHaveLength(0);
  });

  test("a delayed historical failure cannot recover over a newer active turn", async () => {
    const f = fixture();
    f.notify("turn/started", { id: "new", status: "inProgress" });
    f.notify("turn/completed", failure("old"));
    await f.flush();
    expect(f.calls).toHaveLength(0);
  });

  test.each([
    { status: { type: "active" }, turns: [failure("original")] },
    { status: { type: "idle" }, turns: [failure("original"), { id: "new", status: "inProgress" }] },
    { status: { type: "idle" }, turns: [failure("original"), { id: "new", status: "completed" }] },
    { status: { type: "idle" }, turns: [{ id: "original", status: "completed" }] },
    { status: { type: "idle" }, turns: [{ id: "original", status: "failed", error: { message: "Network failure" } }] },
  ])("fresh backend state must still show the same terminal capacity failure: %j", async (thread) => {
    const f = fixture();
    f.notify("turn/completed", failure("original"));
    f.snapshot({ thread });
    await f.flush();
    expect(f.starts()).toHaveLength(0);
  });

  test("a new CLI turn cancels recovery while the state read is in flight", async () => {
    const f = fixture();
    let release: any;
    f.read(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    f.notify("turn/started", { id: "original", status: "inProgress" });
    f.notify("turn/completed", failure("original"));
    const pending = f.flush();
    f.notify("turn/started", { id: "new", status: "inProgress" });
    release({ thread: { turns: [failure("original")] } });
    await pending;
    expect(f.starts()).toHaveLength(0);
  });

  test("three consecutive failed retries back off and stop; explicit CLI input resets the budget", async () => {
    const f = fixture();
    let id = "original";
    for (let attempt = 0; attempt < 3; attempt++) {
      f.snapshot({ thread: { status: { type: "idle" }, turns: [failure(id)] } });
      f.notify("turn/started", { id, status: "inProgress" });
      f.notify("turn/completed", failure(id));
      expect(f.timers[0].delay).toBe(15000 * 2 ** attempt);
      await f.flush();
      id = `retry-${attempt + 1}`;
      // RPC acknowledgment can arrive before the started event.
      f.notify("turn/started", { id, status: "inProgress" });
    }
    f.notify("turn/completed", failure(id));
    expect(f.starts()).toHaveLength(3);
    expect(f.timers).toHaveLength(0);
    f.own("user-new");
    f.notify("turn/started", { id: "user-new", status: "inProgress" });
    f.snapshot({ thread: { turns: [failure("user-new")] } });
    f.notify("turn/completed", failure("user-new"));
    await f.flush();
    expect(f.starts()).toHaveLength(4);
  });

  test("explicit input cancels a waiting timer", async () => {
    const f = fixture();
    f.notify("turn/started", { id: "original", status: "inProgress" });
    f.notify("turn/completed", failure("original"));
    f.recovery.onExplicitInput("cli");
    await f.flush();
    expect(f.calls).toHaveLength(0);
  });

  test("success, user interruption, and invalid reasoning effort never retry", async () => {
    const f = fixture();
    for (const turn of [
      { ...failure("done"), status: "completed" },
      { ...failure("stop"), status: "interrupted" },
      { id: "effort", status: "failed", error: { message: "Maximum reasoning strength too high" } },
    ])
      f.notify("turn/completed", turn);
    await f.flush();
    expect(f.calls).toHaveLength(0);
  });

  test("an unavailable backend state never produces speculative input", async () => {
    const f = fixture();
    f.read(() => {
      throw new Error("Disconnected");
    });
    f.notify("turn/started", { id: "original", status: "inProgress" });
    f.notify("turn/completed", failure("original"));
    await f.flush();
    expect(f.starts()).toHaveLength(0);
    expect(f.errors).toHaveLength(1);
  });
  test.each([{ enabled: false }, { own: false }])(
    "disabled or unowned observers never append input: %j",
    async (options) => {
      const f = fixture(options);
      f.notify("turn/started", { id: "original", status: "inProgress" });
      f.notify("turn/completed", failure("original"));
      await f.flush();
      expect(f.calls).toHaveLength(0);
    },
  );
  test.each(["usageLimitExceeded", "unauthorized", "badRequest", null])(
    "message text cannot override a non-capacity code: %j",
    async (code) => {
      const f = fixture();
      f.notify("turn/started", { id: "original", status: "inProgress" });
      f.notify("turn/completed", {
        ...failure("original"),
        error: { codexErrorInfo: code, message: "The model server is overloaded; usage limit exceeded" },
      });
      await f.flush();
      expect(f.calls).toHaveLength(0);
    },
  );
  test("a stop or disconnect cancels a waiting recovery", async () => {
    for (const action of ["stop", "disconnect"]) {
      const f = fixture();
      f.notify("turn/started", { id: "original", status: "inProgress" });
      f.notify("turn/completed", failure("original"));
      if (action === "stop") f.recovery.onExplicitInput("cli");
      else f.recovery.reset();
      await f.flush();
      expect(f.calls).toHaveLength(0);
    }
  });
  test("elapsed recovery deadline prevents a late continuation", async () => {
    const f = fixture();
    f.notify("turn/started", { id: "original", status: "inProgress" });
    f.notify("turn/completed", failure("original"));
    f.advance(300000);
    await f.flush();
    expect(f.starts()).toHaveLength(0);
  });
  test("only the submitting observer owns a shared terminal event", async () => {
    const owner = fixture(),
      observer = fixture({ own: false });
    for (const f of [owner, observer]) {
      f.notify("turn/started", { id: "original", status: "inProgress" });
      f.notify("turn/completed", failure("original"));
      await f.flush();
    }
    expect(owner.starts()).toHaveLength(1);
    expect(observer.starts()).toHaveLength(0);
  });
  test("a late acknowledgement cannot restore ownership after a stop", async () => {
    const f = fixture({ own: false });
    const claim = f.recovery.onExplicitInput("cli");
    f.notify("turn/started", { id: "original", status: "inProgress" });
    f.notify("turn/completed", failure("original"));
    f.recovery.onExplicitInput("cli");
    f.recovery.onSubmitted("cli", "original", claim);
    await f.flush();
    expect(f.calls).toHaveLength(0);
  });
  test("a terminal event before explicit acknowledgement recovers only after ownership is confirmed", async () => {
    const f = fixture({ own: false });
    const claim = f.recovery.onExplicitInput("cli");
    f.notify("turn/started", { id: "original", status: "inProgress" });
    f.notify("turn/completed", failure("original"));
    expect(f.timers).toHaveLength(0);
    f.recovery.onSubmitted("cli", "original", claim);
    await f.flush();
    expect(f.starts()).toHaveLength(1);
  });
  test("simultaneous failures are paced without occupying normal input", async () => {
    const f = fixture();
    const claim = f.recovery.onExplicitInput("other");
    f.recovery.onSubmitted("other", "other-original", claim);
    f.read(({ threadId }: { threadId: string }) => ({
      thread: { turns: [failure(threadId === "other" ? "other-original" : "original")] },
    }));
    for (const [threadId, id] of [
      ["cli", "original"],
      ["other", "other-original"],
    ]) {
      f.recovery.onNotification({ method: "turn/started", params: { threadId, turn: { id, status: "inProgress" } } });
      f.recovery.onNotification({ method: "turn/completed", params: { threadId, turn: failure(id) } });
    }
    f.advance(15000);
    const first = f.timers.shift(),
      second = f.timers.shift();
    await Promise.all([first.callback(), second.callback()]);
    expect(f.starts()).toHaveLength(1);
    expect(f.timers[0].delay).toBe(15000);
    await f.flush();
    expect(f.starts()).toHaveLength(2);
  });
  test("automatic events before acknowledgement preserve the finite retry budget", async () => {
    const f = fixture();
    let id = "original";
    f.read(() => ({ thread: { turns: [failure(id)] } }));
    f.start(() => {
      id = `retry-${f.starts().length}`;
      f.notify("turn/started", { id, status: "inProgress" });
      f.notify("turn/completed", failure(id));
      return { turn: { id } };
    });
    f.notify("turn/started", { id, status: "inProgress" });
    f.notify("turn/completed", failure(id));
    for (let i = 0; i < 3; i++) await f.flush();
    expect(f.starts()).toHaveLength(3);
    expect(f.timers).toHaveLength(0);
  });
  test("a disconnected or closed state cannot be rearmed by an in-flight acknowledgement", async () => {
    for (const closed of [false, true]) {
      const f = fixture();
      f.start(() => {
        f.notify("turn/started", { id: "retry-1", status: "inProgress" });
        f.notify("turn/completed", failure("retry-1"));
        if (closed) f.recovery.onNotification({ method: "thread/closed", params: { threadId: "cli" } });
        else f.recovery.reset();
        return { turn: { id: "retry-1" } };
      });
      f.notify("turn/started", { id: "original", status: "inProgress" });
      f.notify("turn/completed", failure("original"));
      await f.flush();
      expect(f.timers).toHaveLength(0);
    }
  });
});
