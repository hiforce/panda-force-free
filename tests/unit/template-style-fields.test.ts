import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { bindChannelStyleFields } from "../../src/client/plugins/library/style-fields.js";
import { exampleTemplateDefinition } from "../support/template-definition.mjs";
import type { Translate } from "../../src/shared/i18n/messages.js";
import { nextPackageDraft } from "../../src/client/publishing-styles/catalog.js";

const t: Translate = (id) => id;
test("editing an installed package starts above retained numeric versions without changing the original", () => {
  const value = exampleTemplateDefinition().package;
  const before = structuredClone(value);
  const draft = nextPackageDraft(value, ["1.0.9", "1.0.10", "1.0.2"]);
  expect(draft!.manifest.version).toBe("1.0.11");
  expect(draft!.manifest.id).toBe(value.manifest.id);
  expect(draft!.manifest.channelTemplates).toEqual(value.manifest.channelTemplates);
  expect(value).toEqual(before);
  expect(nextPackageDraft(value, ["1.0.9999"])!.manifest.version).toBe("1.1.0");
  expect(nextPackageDraft(value, ["1.9999.9999"])!.manifest.version).toBe("2.0.0");
  expect(nextPackageDraft(value, ["9999.9999.9999"])).toBeNull();
});
test("visual style patches preserve other exports and follow the same editable JSON definition", () => {
  const dom = new JSDOM("<main><section></section><textarea></textarea></main>");
  try {
    const host = dom.window.document.querySelector("section")!;
    const source = dom.window.document.querySelector("textarea")!;
    const manifest = exampleTemplateDefinition().package.manifest;
    const second = { ...structuredClone(manifest.channelTemplates[0]!), id: "second", name: "Second" };
    const original = { ...manifest, channelTemplates: [...manifest.channelTemplates, second] };
    source.value = JSON.stringify(original);
    let edits = 0;
    source.addEventListener("input", () => edits++);
    bindChannelStyleFields(host, source, t);
    const size = host.querySelector<HTMLSelectElement>('[data-style-field="size"]')!;
    size.value = "20px";
    size.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    const patched = JSON.parse(source.value);
    expect(patched.channelTemplates[0].style.size).toBe("20px");
    expect(patched.channelTemplates[1]).toEqual(second);
    expect(patched.permissions).toEqual(original.permissions);
    expect(patched.siteThemes).toEqual(original.siteThemes);
    expect(edits).toBe(1);
    const choose = host.querySelector<HTMLSelectElement>("[data-style-entry]")!;
    choose.value = "second";
    choose.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    choose.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    expect(edits).toBe(1);
    expect(host.querySelector<HTMLSelectElement>('[data-style-field="size"]')!.value).toBe(second.style.size);
    patched.channelTemplates[1].style.size = "22px";
    source.value = JSON.stringify(patched);
    source.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    expect(host.querySelector<HTMLSelectElement>('[data-style-field="size"]')!.value).toBe("22px");
  } finally {
    dom.window.close();
  }
});

test("unfinished or unsafe advanced JSON stays intact and can recover without restoring a stale form copy", () => {
  const dom = new JSDOM("<section></section><textarea></textarea>");
  try {
    const host = dom.window.document.querySelector("section")!,
      source = dom.window.document.querySelector("textarea")!;
    const manifest = exampleTemplateDefinition().package.manifest;
    source.value = JSON.stringify(manifest);
    bindChannelStyleFields(host, source, t);
    for (const raw of [
      '{"channelTemplates":',
      JSON.stringify({
        ...manifest,
        channelTemplates: [
          {
            ...manifest.channelTemplates[0],
            style: { ...manifest.channelTemplates[0]!.style, accent: "url(https://secret.invalid)" },
          },
        ],
      }),
    ]) {
      source.value = raw;
      source.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      expect(source.value).toBe(raw);
      expect(host.textContent).toBe("plugins.stylesFieldsInvalid");
      expect(host.querySelector("[data-style-field]")).toBeNull();
    }
    manifest.channelTemplates[0]!.style.accent = "#123456";
    source.value = JSON.stringify(manifest);
    source.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    expect(host.querySelector<HTMLInputElement>('[data-style-field="accent"]')!.value).toBe("#123456");
  } finally {
    dom.window.close();
  }
});
