import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { createConversationRendererRegistry } from "../../src/client/conversation-renderers/registry.js";
import { createHistoryProjectionBoundary } from "../../src/client/conversation-interactions.js";
import type { ConversationRenderer } from "../../src/client/conversation-renderers/types.js";

describe("conversation extension contract", () => {
  test("a new control updates one root and releases its resources exactly once", () => {
    const document = new JSDOM("<main></main>").window.document;
    const root = document.querySelector("main")!;
    let disposed = 0;
    const control: ConversationRenderer = {
      id: "test-control",
      types: ["customControl"],
      render({ element, item }) {
        const node = element || document.createElement("button");
        node.textContent = item.text || "";
        return node;
      },
      dispose() {
        disposed++;
      },
    };
    const registry = createConversationRendererRegistry([control]);
    const item = { id: "control", type: "customControl", text: "First value" };
    expect(registry.resolve(item)).toBe(control);
    const node = registry.render(control, { item, root, turnId: "turn", element: null });
    expect(
      registry.render(control, { item: { ...item, text: "Updated value" }, root, turnId: "turn", element: node }),
    ).toBe(node);
    expect(node?.textContent).toBe("Updated value");
    registry.release(node!);
    registry.release(node!);
    expect(disposed).toBe(1);
    expect(registry.resolve({ id: "unknown", type: "unknown" })).toBeNull();
  });

  test("specialized controls precede generic text without silent shadowing", () => {
    const generic: ConversationRenderer = { id: "text", types: ["message"], render: () => null };
    const special: ConversationRenderer = { ...generic, id: "control", matches: (item) => item.delivery === "async" };
    const registry = createConversationRendererRegistry([special, generic]);
    expect(registry.resolve({ id: "a", type: "message", delivery: "async" })).toBe(special);
    expect(registry.resolve({ id: "b", type: "message" })).toBe(generic);
    expect(() => createConversationRendererRegistry([generic, special])).toThrow("unreachable");
    expect(() => createConversationRendererRegistry([generic, generic])).toThrow("Duplicate");
  });

  test("history updates wait for interaction, coalesce, and cancel on navigation", async () => {
    let interacting = true;
    const rendered: string[] = [];
    const boundary = createHistoryProjectionBoundary(() => interacting);
    const first = boundary.render(() => {
      rendered.push("stale");
    });
    const latest = boundary.render(() => {
      rendered.push("latest");
    });
    expect(first).toBe(latest);
    let applied = false;
    void first.then(() => {
      applied = true;
    });
    boundary.flush();
    expect(rendered).toEqual([]);
    expect(applied).toBe(false);
    interacting = false;
    boundary.flush();
    await first;
    expect(applied).toBe(true);
    expect(rendered).toEqual(["latest"]);
    interacting = true;
    const cancelled = boundary.render(() => {
      rendered.push("old session");
    });
    boundary.cancel();
    await cancelled;
    interacting = false;
    boundary.flush();
    boundary.render(() => rendered.push("new session"));
    expect(rendered).toEqual(["latest", "new session"]);
  });
});
