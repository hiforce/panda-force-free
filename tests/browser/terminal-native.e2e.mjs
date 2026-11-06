import qualityAssert from "node:assert/strict";
import { createBrowserFixture } from "../support/browser-runtime.mjs";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runtime = await createBrowserFixture();

let browser, page, terminalFixture;
try {
  const chrome =
    process.env.PLAYWRIGHT_CHROME ||
    [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge Canary.app/Contents/MacOS/Microsoft Edge Canary",
    ].find(existsSync);
  browser = await runtime.launchBrowser({ headless: true, ...(chrome ? { executablePath: chrome } : {}) });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  terminalFixture = mkdtempSync(join(tmpdir(), "panda-force-terminal-"));
  const vimFile = join(terminalFixture, "vim-test.txt");
  await page.goto(runtime.base + "/new", { waitUntil: "networkidle" });
  await page.fill("#prompt", "检查输入框横线与终端键盘支持");

  const composer = await page.evaluate(() => ({
    value: document.querySelector("#prompt")?.value,
    borderTop: getComputedStyle(document.querySelector(".composer-dock")).borderTop,
  }));

  await page.click("#toggleSidePanel");
  await page.click('[data-side-panel-action="terminal"]');
  await page.waitForSelector("#sideTerminalHost .xterm", { timeout: 10_000 });
  await page.locator("#sideTerminalHost .xterm-helper-textarea").focus();
  await page.waitForFunction(() => document.querySelector("#sideTerminalHost")?.dataset.connected === "true");
  await page.keyboard.type("printf '\\033[31mANSI_RED\\033[0m \\033[32mANSI_GREEN\\033[0m\\n'");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => {
    const term = globalThis.__codexTerminals?.side?.term;
    return (
      term &&
      [...Array(term.buffer.active.length)].some((_, index) =>
        term.buffer.active.getLine(index)?.translateToString(true).includes("ANSI_RED ANSI_GREEN"),
      )
    );
  });
  await page.waitForFunction(() =>
    [...document.querySelectorAll("#sideTerminalHost .xterm-rows > div")].some(
      (node) => node.textContent?.trim() === "ANSI_RED ANSI_GREEN",
    ),
  );

  const ansi = await page.evaluate(() => {
    const row = [...document.querySelectorAll("#sideTerminalHost .xterm-rows > div")].find(
      (node) => node.textContent?.trim() === "ANSI_RED ANSI_GREEN",
    );
    const spans = [...(row?.querySelectorAll("span") || [])];
    const red = spans.find((node) => node.textContent?.includes("ANSI_RED"));
    const green = spans.find((node) => node.textContent?.includes("ANSI_GREEN"));
    return {
      red: red ? getComputedStyle(red).color : null,
      green: green ? getComputedStyle(green).color : null,
      text: row?.textContent || "",
    };
  });

  await page.keyboard.type(`vim -Nu NONE -i NONE -n --cmd 'set ttimeoutlen=10' ${vimFile}`);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => globalThis.__codexTerminals?.side?.term?.buffer.active.type === "alternate");
  await page.keyboard.press("i");
  await page.keyboard.type("value=10");
  await page.keyboard.press("Enter");
  await page.keyboard.type("second");
  await page.keyboard.press("Enter");
  await page.keyboard.type("third");
  await page.keyboard.press("Escape");
  await page.keyboard.type("gg0");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Control+x");
  await page.keyboard.press("A");
  await page.keyboard.type(" CTRL_C_OK");
  await page.keyboard.press("Control+c");
  await page.keyboard.type(":wq");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => globalThis.__codexTerminals?.side?.term?.buffer.active.type === "normal");

  await page.keyboard.type(`printf 'VIM_FILE='; cat ${vimFile}`);
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => {
      const term = globalThis.__codexTerminals?.side?.term;
      return (
        term &&
        [...Array(term.buffer.active.length)].some((_, index) =>
          term.buffer.active.getLine(index)?.translateToString(true).includes("VIM_FILE=value=9 CTRL_C_OK"),
        )
      );
    },
    null,
    { timeout: 10_000 },
  );

  const terminal = await page.evaluate(() => ({
    title: document.querySelector("#utilityTab")?.textContent?.trim(),
    xterm: Boolean(document.querySelector("#sideTerminalHost .xterm")),
    rows: document.querySelector("#sideTerminalHost .xterm-rows")?.textContent || "",
    connected: document.querySelector("#sideTerminalHost")?.dataset.connected,
  }));

  console.log(JSON.stringify({ composer, ansi, terminal, errors }, null, 2));
  await page.screenshot({ path: ".artifacts/terminal-open.png" });

  {
    qualityAssert.equal(
      composer.value,
      "检查输入框横线与终端键盘支持",
      "Condition: composer.value !== '检查输入框横线与终端键盘支持'",
    );
  }
  {
    qualityAssert.ok(
      !(composer.borderTop !== "0px none rgb(242, 242, 242)" && !composer.borderTop.startsWith("0px")),
      "Condition: composer.borderTop !== '0px none rgb(242, 242, 242)' && !composer.borderTop.startsWith('0px')",
    );
  }
  {
    qualityAssert.ok(terminal.xterm, "Condition: !terminal.xterm");
    qualityAssert.equal(terminal.title, "Terminal", "Condition: terminal.title !== 'Terminal'");
    qualityAssert.equal(terminal.connected, "true", "Condition: terminal.connected !== 'true'");
  }
  {
    qualityAssert.ok(ansi.text.includes("ANSI_RED"), "Condition: !ansi.text.includes('ANSI_RED')");
    qualityAssert.ok(ansi.text.includes("ANSI_GREEN"), "Condition: !ansi.text.includes('ANSI_GREEN')");
    qualityAssert.ok(!(ansi.red === ansi.green), "Condition: ansi.red === ansi.green");
  }
  {
    qualityAssert.ok(
      terminal.rows.includes("VIM_FILE=value=9 CTRL_C_OK"),
      "Condition: !terminal.rows.includes('VIM_FILE=value=9 CTRL_C_OK')",
    );
    qualityAssert.ok(!errors.length, "Condition: errors.length");
  }
} catch (error) {
  if (page)
    console.error(
      "Terminal diagnostics",
      await page
        .evaluate(() => ({
          connected: document.querySelector("#sideTerminalHost")?.dataset.connected,
          rows: document.querySelector("#sideTerminalHost .xterm-rows")?.textContent || "",
          buffer: globalThis.__codexTerminals?.side?.term?.buffer.active.type,
        }))
        .catch(() => null),
    );
  throw error;
} finally {
  if (browser) await browser.close();
  else await runtime.dispose();
  if (terminalFixture) rmSync(terminalFixture, { recursive: true, force: true });
}
