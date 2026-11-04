import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { sendAuthPage } from "../src/server/auth/pages.js";

test("public login and workspace chrome use PandaForce while naming the connected engine", () => {
  const source = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const document = new JSDOM(source).window.document;
  expect(document.title).toBe("PandaForce");
  expect(document.querySelector(".auth-brand")!.textContent?.trim()).toBe("PandaForce");
  expect(document.querySelector(".window-brand strong")!.textContent).toBe("PandaForce");
  expect(document.querySelector("#passwordGate")!.getAttribute("aria-label")).toBe("PandaForce login");
  expect(document.querySelector("#productModeButton")!.getAttribute("aria-label")).toContain("Codex");
});

test("standalone authentication pages keep PandaForce branding and relogin actions in every locale", () => {
  for (const language of ["en", "zh-CN", "fr-FR"]) {
    for (const kind of ["denied", "incomplete", "rejected", "limited", "unavailable", "signedOut"]) {
      let html = "";
      sendAuthPage({ writeHead() {}, end(value) { html = value; } }, { kind, status: kind === "signedOut" ? 200 : 403, language });
      const document = new JSDOM(html).window.document;
      expect(document.title).toContain("PandaForce");
      expect(document.querySelector(".brand")!.textContent).toBe("PandaForce");
      expect(document.querySelector("[data-panda-force-mark]")).not.toBeNull();
      expect(document.querySelector('link[rel="icon"]')!.getAttribute("href")).toStartWith("data:image/svg+xml,");
      if (kind === "signedOut") expect(document.querySelector(".action")!.getAttribute("href")).toBe("/auth/login");
      else expect(document.querySelector("form")!.getAttribute("action")).toBe("/auth/relogin");
    }
  }
});
