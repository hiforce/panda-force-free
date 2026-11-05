import { JSDOM } from "jsdom";
import { describe, expect, test } from "bun:test";
import { pandaInterfaceMark } from "../../src/client/panda-brand.js";
import { codexIcon, codexIconNodes, hydrateCodexIcons } from "../../src/client/codex-icons.js";

describe("Codex icon assets", () => {
  test("uses the exact Lucide 0.456 paths extracted from Codex.app", () => {
    expect(codexIconNodes.paperclip).toContain("m21.44 11.05-9.19 9.19");
    expect(codexIconNodes.panelLeft).toContain('width="18" height="18" x="3" y="3" rx="2"');
    expect(codexIconNodes.panelBottom).toContain("M3 15h18");
    expect(codexIconNodes.refreshCw).toContain("M3 12a9 9 0 0 1 9-9");
    expect(codexIconNodes.folderOpen).toContain("m6 14 1.5-2.9");
  });

  test("the compatible brand entry point renders the PandaForce mark", () => {
    const html = pandaInterfaceMark("assistant-mark");
    expect(html).toContain("data-panda-force-mark");
    expect(html).toContain('viewBox="0 0 32 32"');
    expect(html).toContain("assistant-mark");
    expect(html).not.toContain("data-panda-interface-mark");
    expect(html).not.toContain("img");
  });

  test("renders a standard icon slot", () => {
    const html = codexIcon("arrowUp", "send-icon");
    expect(html).toContain('class="icon-slot send-icon"');
    expect(html).toContain('viewBox="0 0 24 24"');
    expect(html).toContain("M12 19V5");
  });

  test("renders the filled stop square used by the active composer", () => {
    const html = codexIcon("square", "stop-icon");
    expect(html).toContain('class="icon-slot stop-icon"');
    expect(html).toContain('fill="currentColor"');
    expect(html).toContain('stroke="none"');
  });

  test("hydrates static placeholders", () => {
    const dom = new JSDOM('<span data-icon="plus"></span>');
    try {
      hydrateCodexIcons(dom.window.document);
      expect(dom.window.document.querySelector("[data-icon]")?.innerHTML).toContain("M5 12h14");
    } finally {
      dom.window.close();
    }
  });
});
