import { expect, test } from "bun:test";
import { creativeText } from "../../src/server/creative/assets/text.js";
import { creativeSaveInput } from "../../src/server/creative/assets/prepare.js";
import { officeFixture } from "../support/office-presentation.js";
import { randomUUID } from "node:crypto";

test("HTML citation text follows parsed DOM, never scripts, hidden content, templates or fetched URLs", async () => {
  const html = Buffer.from(
      `<!doctype html><title>Metadata</title><h1>English &amp; 日本語</h1><p>One <b>two</b> three.</p><script>fetch('https://must-not-fetch.invalid')</script><style>body{display:none}</style><template>Uninstalled template</template><div hidden>Private hidden text</div><iframe src="https://must-not-fetch.invalid">Frame</iframe><p>Tail</p>`,
    ),
    result = await creativeText("web", "index.html", html);
  expect(result.text).toBe("English & 日本語\nOne two three.\nTail");
  expect(result.sections).toEqual([{ id: "web-body", start: 0, end: result.text.length }]);
  await expect(creativeText("web", "index.html", new Uint8Array([0xff]))).rejects.toThrow();
});
test("native slide text is ordered by package relationships and has exact per-slide citation boundaries", async () => {
  const f = officeFixture({ slides: 2, strict: true }),
    result = await creativeText("slides", "deck.pptx", f.bytes());
  expect(result.sections.map((s) => s.id)).toEqual(["slide-1", "slide-2"]);
  for (const section of result.sections) {
    const text = result.text.slice(section.start, section.end);
    expect(text).toContain("Hello world");
    expect(text).toContain("world\nNext line");
    expect(text).toContain("Nested world");
    expect(text).not.toContain("Layout");
    expect(text).not.toContain("outside.invalid");
  }
  await expect(creativeText("slides", "template.pptx", officeFixture({ kind: "potx" }).bytes())).rejects.toThrow();
});
test("save preparation freezes caller buffers and rejects borrowed resource identities and traversal names", () => {
  const bytes = Buffer.from("<p>Original</p>"),
    resource = Buffer.from([1, 2, 3]),
    input = {
      id: "c-" + randomUUID(),
      operationId: randomUUID(),
      expectedVersion: null,
      kind: "web" as const,
      title: "Saved",
      locale: "en",
      name: "index.html",
      bytes,
      resources: [{ name: "images/hero.png", bytes: resource }],
    },
    captured = creativeSaveInput(input);
  bytes.fill(0);
  resource.fill(0);
  input.resources[0]!.name = "changed";
  expect(captured.bytes.toString()).toBe("<p>Original</p>");
  expect(captured.resources[0]!.bytes).toEqual(Buffer.from([1, 2, 3]));
  expect(captured.resources[0]!.name).toBe("images/hero.png");
  for (const name of ["../x", "/x", "a/./x", "a%2fb", "a\\b", "a\u0001b", "bad\ud800.html", "bad\u202e.html"])
    expect(() => creativeSaveInput({ ...input, name })).toThrow();
});
