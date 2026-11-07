import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

// Exercise real browser layout and deferred scroll events independently of RPC timing.
export async function checkConversationScrollGeometry(browser) {
  const bundle = await Bun.build({
    entrypoints: [fileURLToPath(new URL("../../src/client/application/viewport.js", import.meta.url))],
    target: "browser",
  });
  assert.equal(bundle.success, true);
  const moduleUrl = "data:text/javascript;base64," + Buffer.from(await bundle.outputs[0].text()).toString("base64");
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage();
    await page.setContent(
      '<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}#conversation{height:400px;overflow:auto}article{height:200px;margin:0}</style><main id="conversation">' +
        Array.from({ length: 12 }, (_, index) => `<article data-item-id="${index}">Message ${index}</article>`).join(
          "",
        ) +
        '</main><button id="conversationScrollBottom">Latest</button>',
    );
    await page.evaluate(async (url) => {
      const { assembleViewport } = await import(url);
      window.viewportApi = assembleViewport({ $: (selector) => document.querySelector(selector) });
      window.viewportApi.bind();
      window.viewportApi.scrollOpenedThreadToBottom();
    }, moduleUrl);
    const bottom = () =>
      page.waitForFunction(
        () => {
          const root = document.querySelector("#conversation");
          return root.scrollHeight - root.scrollTop - root.clientHeight < 2;
        },
        null,
        { timeout: 3000 },
      );
    await bottom();

    await page.evaluate(() => {
      const root = document.querySelector("#conversation");
      const maximum = root.scrollHeight - root.clientHeight;
      let elasticTop = maximum + 80;
      Object.defineProperty(root, "scrollTop", { configurable: true, get: () => elasticTop });
      root.dispatchEvent(new Event("scroll"));
      elasticTop = maximum;
      root.dispatchEvent(new Event("scroll"));
      delete root.scrollTop;
      root.lastElementChild.style.height = "400px";
      window.viewportApi.scrollBottom();
    });
    await bottom();
    await page.evaluate(() => {
      const root = document.querySelector("#conversation"),
        item = root.lastElementChild;
      item.style.height = "20px";
      // Force the transient clamp produced by a collapsed activity or rebuilt message.
      void root.scrollTop;
      item.style.height = "600px";
      window.viewportApi.scrollBottom();
    });
    await bottom();

    await page.evaluate(() => {
      const item = document.querySelector("#conversation").lastElementChild;
      item.style.height = "auto";
      window.paragraphs = (expanded) =>
        Array.from(
          { length: 30 },
          (_, index) =>
            `<p style="height:${expanded && index === 0 ? 245 : 45}px;margin:0" data-line="${index}">Paragraph ${index}</p>`,
        ).join("");
      item.innerHTML = window.paragraphs(false);
      window.viewportApi.scrollOpenedThreadToBottom();
    });
    await bottom();
    const line = page.locator('[data-line="16"]');
    await line.evaluate((node) => {
      const root = document.querySelector("#conversation");
      root.scrollTop += node.getBoundingClientRect().top - root.getBoundingClientRect().top - 20;
    });
    await page.locator("#conversationScrollBottom").waitFor({ state: "visible" });
    const position = () => line.evaluate((node) => node.getBoundingClientRect().top);
    const before = await position();
    await page.evaluate(() =>
      window.viewportApi.preserveReadingPosition(() => {
        document.querySelector("#conversation").lastElementChild.innerHTML = window.paragraphs(true);
      }),
    );
    await page.waitForTimeout(200);
    assert.ok(Math.abs((await position()) - before) < 2, "A replaced long response must retain the visible paragraph");

    // High refresh-rate scrolling can deliver many one-pixel steps between
    // streamed updates. Every step must advance the paused reading anchor.
    for (const step of [1, -1]) {
      const moved = await page.locator("#conversation").evaluate((root, step) => {
        const initial = root.scrollTop;
        for (let index = 0; index < 90; index++) {
          root.scrollTop += step;
          root.dispatchEvent(new Event("scroll"));
        }
        const latest = root.scrollTop;
        window.viewportApi.preserveReadingPosition(() => {
          root.lastElementChild.append(
            Object.assign(document.createElement("p"), { textContent: "Output after small reading movements." }),
          );
        });
        return { initial, latest };
      }, step);
      assert.ok(Math.abs(moved.latest - moved.initial) >= 89, "The fixture must actually move the reading position");
      await page.waitForTimeout(200);
      assert.ok(
        Math.abs((await page.locator("#conversation").evaluate((root) => root.scrollTop)) - moved.latest) < 2,
        "Small upward and downward steps must not snap back to an earlier reading position after output",
      );
    }

    await page.locator("#conversation").evaluate((root) => {
      root.scrollTop = 500;
    });
    await page.waitForTimeout(100);
    await page.evaluate(() => {
      const root = document.querySelector("#conversation");
      root.dispatchEvent(new WheelEvent("wheel", { deltaY: 1000, bubbles: true }));
      root.scrollTop = root.scrollHeight;
      root.lastElementChild.append(
        Object.assign(document.createElement("p"), { textContent: "New streamed content ".repeat(100) }),
      );
      window.viewportApi.scrollBottom();
    });
    await bottom();

    // Reproduce a finger return to the bottom while a same-size history
    // projection transiently empties the scroller before restoring its content.
    await page.evaluate(() => {
      const root = document.querySelector("#conversation");
      window.testTouch = (type, y) => {
        const event = new Event(type, { bubbles: true });
        Object.defineProperty(event, "touches", { value: y === null ? [] : [{ clientY: y }] });
        root.dispatchEvent(event);
      };
      window.testTouch("touchstart", 150);
      window.testTouch("touchmove", 250);
      root.scrollTop = 500;
      root.dispatchEvent(new Event("scroll"));
      window.testTouch("touchend", null);
    });
    await page.waitForTimeout(250);
    await page.evaluate(() => {
      const root = document.querySelector("#conversation");
      window.testTouch("touchstart", 350);
      window.testTouch("touchmove", 100);
      root.scrollTop = root.scrollHeight;
      root.dispatchEvent(new Event("scroll"));
      window.viewportApi.preserveReadingPosition(() => {
        const content = root.innerHTML;
        root.innerHTML = "";
        void root.scrollTop;
        root.innerHTML = content;
      });
    });
    await bottom();
    await page.evaluate(() => window.testTouch("touchend", null));
    await page.waitForTimeout(250);
    await bottom();
    await page.evaluate(() => {
      window.viewportApi.preserveReadingPosition(() => {
        document.querySelector("#conversation").lastElementChild.append(
          Object.assign(document.createElement("p"), {
            textContent: "Delayed output after returning to the bottom. ".repeat(30),
          }),
        );
      });
    });
    await bottom();

    await page.evaluate(() => {
      const root = document.querySelector("#conversation");
      const native = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
      window.scrollWrites = 0;
      window.nativeScroll = (top) => native.set.call(root, top);
      Object.defineProperty(root, "scrollTop", {
        get() {
          return native.get.call(root);
        },
        set(value) {
          window.scrollWrites++;
          native.set.call(root, value);
        },
      });
      window.touch = (type, y) => {
        const event = new Event(type, { bubbles: true });
        Object.defineProperty(event, "touches", { value: y === null ? [] : [{ clientY: y }] });
        root.dispatchEvent(event);
      };
      window.touch("touchstart", 150);
    });
    for (let step = 0; step < 8; step++) {
      const expected = await page.evaluate((step) => {
        const root = document.querySelector("#conversation");
        window.touch("touchmove", 180 + step * 20);
        window.nativeScroll(root.scrollTop - 50);
        const top = root.scrollTop;
        root.lastElementChild.append(
          Object.assign(document.createElement("p"), { textContent: "Output while dragging ".repeat(20) }),
        );
        return top;
      }, step);
      await page.waitForTimeout(35);
      assert.ok(
        Math.abs((await page.locator("#conversation").evaluate((root) => root.scrollTop)) - expected) < 2,
        "Streaming below a touch gesture must not pull the reader back",
      );
    }
    await page.evaluate(() => window.touch("touchend", null));
    await page.waitForTimeout(250);
    assert.equal(
      await page.evaluate(() => window.scrollWrites),
      0,
      "No redundant scroll writes may interrupt dragging or momentum",
    );
    await page.locator("#conversationScrollBottom").click();
    await bottom();
    if (browser.browserType().name() === "chromium") {
      const session = await context.newCDPSession(page);
      const initial = await page.locator("#conversation").evaluate((root) => root.scrollTop);
      await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 200, y: 120 }] });
      for (let step = 1; step <= 6; step++) {
        await session.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: 200, y: 120 + 20 * step }],
        });
        await page.evaluate(() => {
          document
            .querySelector("#conversation")
            .lastElementChild.append(
              Object.assign(document.createElement("p"), { textContent: "Output during a native swipe. ".repeat(20) }),
            );
        });
        await page.waitForTimeout(30);
      }
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForTimeout(600);
      const settled = await page.locator("#conversation").evaluate((root) => root.scrollTop);
      assert.ok(settled < initial - 30, "A native upward reading gesture must pause following during output");
      await page.evaluate(() => {
        document
          .querySelector("#conversation")
          .lastElementChild.append(
            Object.assign(document.createElement("p"), { textContent: "Output after the native swipe. ".repeat(20) }),
          );
      });
      await page.waitForTimeout(200);
      assert.ok(
        Math.abs((await page.locator("#conversation").evaluate((root) => root.scrollTop)) - settled) < 2,
        "Reading must remain stable after native touch momentum ends",
      );
      await session.detach();
    }
    await page.locator("#conversationScrollBottom").evaluate((button) => button.click());
    await bottom();
    const contact = browser.browserType().name() === "chromium" ? await context.newCDPSession(page) : null;
    if (contact)
      await contact.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: 180, y: 200 }],
      });
    else
      await page.evaluate(() => {
        window.detachedTouchTarget = document.elementFromPoint(180, 200);
        const event = new Event("touchstart", { bubbles: true });
        Object.defineProperty(event, "touches", { value: [{ clientY: 200 }] });
        window.detachedTouchTarget.dispatchEvent(event);
      });
    await page.evaluate(() => {
      window.viewportApi.preserveReadingPosition(() => {
        document.querySelector("#conversation").lastElementChild.innerHTML += "<p>Text arrives during contact.</p>";
      });
    });
    if (contact) {
      await contact.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await contact.detach();
    } else
      await page.evaluate(() => {
        const event = new Event("touchend", { bubbles: true });
        Object.defineProperty(event, "touches", { value: [] });
        window.detachedTouchTarget.dispatchEvent(event);
      });
    await page.waitForTimeout(250);
    await bottom();
    await page.evaluate(() => {
      document.querySelector("#conversation").lastElementChild.append(
        Object.assign(document.createElement("p"), {
          textContent: "Following resumes after the original touch target is detached. ".repeat(20),
        }),
      );
      window.viewportApi.scrollBottom();
    });
    await bottom();
    await page.evaluate(() => {
      const root = document.querySelector("#conversation");
      const item = document.createElement("article");
      item.dataset.itemId = "short-conversation";
      item.style.height = "20px";
      item.textContent = "A short conversation";
      root.replaceChildren(item);
      window.viewportApi.scrollOpenedThreadToBottom();
      root.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
      item.style.height = "600px";
    });
    await bottom();
    return {
      elasticBottom: true,
      layoutClamp: true,
      paragraphAnchor: true,
      smallReadingSteps: true,
      returnToBottomRace: true,
      touchReturnAcrossReplacement: true,
      detachedTouchTarget: true,
      gestureWrites: 0,
    };
  } finally {
    await context.close();
  }
}
