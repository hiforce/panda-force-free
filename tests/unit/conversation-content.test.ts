import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { setConversationContent } from "../../src/client/conversation-renderers/content.js";
import { isRetainedConversationItem } from "../../src/client/conversation-interactions.js";

test("image identity survives streamed text while changed image attributes take effect", () => {
  const document = new JSDOM("<main></main>").window.document;
  const root = document.querySelector("main")!;
  const image = '<img class="message-image" src="/first.png" alt="First">';
  setConversationContent(root, "<p>First</p>" + image);
  const decoded = root.querySelector("img");
  const firstText = root.firstChild;
  setConversationContent(root, "<p>First</p>" + image);
  expect(root.firstChild).toBe(firstText);
  setConversationContent(root, "<p>First and second</p>" + image);
  expect(root.querySelector("img")).toBe(decoded);
  expect(root.querySelector("p")?.textContent).toBe("First and second");
  expect(isRetainedConversationItem(root)).toBe(true);
  setConversationContent(root, '<img class="message-image" src="/second.png" alt="Second">');
  expect(root.querySelector("img")).not.toBe(decoded);
  expect(root.querySelector("img")?.getAttribute("src")).toBe("/second.png");
  setConversationContent(root, "<p>Only text</p>");
  expect(isRetainedConversationItem(root)).toBe(false);
});

test("duplicate image references remain separate nodes and each update is sanitized", () => {
  const document = new JSDOM("<main></main>").window.document;
  const root = document.querySelector("main")!;
  const image = '<img class="message-image" src="/same.png" alt="Same">';
  setConversationContent(root, image + image);
  const originals = [...root.querySelectorAll("img")];
  expect(originals).toHaveLength(2);
  setConversationContent(root, image + image + '<p onclick="alert(1)">Updated</p><script>alert(1)</script>');
  expect([...root.querySelectorAll("img")]).toEqual(originals);
  expect(root.querySelector("script,[onclick]")).toBeNull();
  setConversationContent(root, '<img class="message-image" src="javascript:alert(1)" onerror="alert(1)">');
  expect(root.querySelector("img")?.hasAttribute("src")).toBe(false);
  expect(root.querySelector("[onerror]")).toBeNull();
});
