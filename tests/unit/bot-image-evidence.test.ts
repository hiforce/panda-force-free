import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { BotStore } from "../../src/server/bots/store.js";
import { BotWorker } from "../../src/server/bots/worker.js";
import { botTaskInput } from "../../src/shared/bots/contracts.js";
import type { ApplicationToolEngine } from "../../src/shared/engine/application-tools.js";
const review = {
  question: "The image could not be verified. How should we continue?",
  options: [
    { id: "retry", label: "Retry with accessible images" },
    { id: "supply", label: "I will provide corrected product information" },
  ],
};
for (const mode of ["confident", "uncertain", "failed", "partial", "missing", "retry"] as const)
  test(`text-first decisions use images only for secondary confirmation: ${mode}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "bot-evidence-")),
      store = new BotStore(":memory:");
    const bot = store.createBot("owner", {
      code: "evidence",
      name: "Evidence review",
      callbackHosts: ["callback.example"],
    });
    const value = botTaskInput({
      externalTaskId: "image-" + mode,
      instructions: "Use text first; check supplied images if uncertain.",
      input: {
        text: "Half Cab Pin Black. A flat enamel pin, not footwear.",
        images: mode === "missing" ? [] : ["https://assets.example/front.jpg", "https://assets.example/back.jpg"],
      },
      actions: [
        {
          id: "reject_product",
          label: "Reject product",
          callback: { url: "https://callback.example/reject", method: "POST", body: { scope: "product-1" } },
        },
      ],
    });
    const pixels = await sharp({ create: { width: 200, height: 200, channels: 3, background: "#ffffff" } })
      .jpeg()
      .toBuffer();
    let posts = 0,
      gets = 0,
      receipt: unknown;
    const accepted = ["confident", "uncertain", "retry"].includes(mode);
    const engine: ApplicationToolEngine = {
      id: "evidence",
      async run(input, callbacks) {
        await callbacks.session?.("image-session");
        await callbacks.started({ sessionId: "image-session", runId: "image-run" });
        const prompt = JSON.parse(input.prompt),
          taskId = prompt.taskId;
        expect(prompt.actions[0]).not.toHaveProperty("requiresImages");
        const call = (name: string, arguments_: Record<string, unknown>) =>
          callbacks.call({
            sessionId: "image-session",
            runId: "image-run",
            callId: crypto.randomUUID(),
            name,
            arguments: { taskId, ...arguments_ },
          });
        if (mode !== "confident") {
          const result = await call("panda_bot_images", {});
          expect(result.success).toBe(mode === "uncertain");
          if (mode === "retry") expect((await call("panda_bot_images", {})).success).toBe(true);
        }
        const decision = await call("panda_bot_decide", {
          decision: "reject_product",
          reason:
            mode === "confident"
              ? "The description explicitly identifies an enamel pin."
              : "The image shows a flat shoe-shaped enamel pin with a metal outline.",
        });
        expect(decision.success).toBe(accepted);
        if (!accepted)
          await call("panda_bot_decide", {
            decision: "review",
            reason: "Secondary image confirmation failed; keep the task for review.",
            review,
          });
        return { sessionId: "image-session", runId: "image-run", status: "completed" };
      },
    };
    const worker = new BotWorker(
      store,
      () => engine,
      root,
      async (_url, options) => {
        if (options.method === "POST") {
          posts++;
          receipt = JSON.parse(options.body!);
          return { status: 200, type: "application/json", body: Buffer.from('{"success":true}') };
        }
        gets++;
        return mode === "failed" || (mode === "partial" && gets === 2) || (mode === "retry" && gets === 1)
          ? { status: 403, type: "text/html", body: Buffer.from("denied") }
          : { status: 200, type: "image/jpeg", body: pixels };
      },
    );
    try {
      const task = store.submit(bot, value, mode).task;
      worker.start();
      const end = Date.now() + 4000;
      while (["queued", "running"].includes(store.task("owner", task.id).status)) {
        if (Date.now() > end) throw Error("Task did not finish");
        await Bun.sleep(5);
      }
      const saved = store.task("owner", task.id);
      expect(posts).toBe(accepted ? 1 : 0);
      if (mode === "confident") {
        expect(gets).toBe(0);
        expect(saved.imageEvidence).toBeUndefined();
        expect(receipt).not.toHaveProperty("imageEvidence");
      } else if (accepted) {
        expect(saved.imageEvidence?.images).toEqual(value.input.images);
        expect(receipt).toMatchObject({ imageEvidence: { observations: saved.imageEvidence!.observations } });
      } else {
        expect(saved.status).toBe("review");
        expect(saved.imageEvidence).toBeUndefined();
      }
    } finally {
      await worker.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
