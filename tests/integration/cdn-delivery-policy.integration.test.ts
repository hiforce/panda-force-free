import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a required CDN build cannot start or initialize authentication with missing CDN output", async () => {
  const root = mkdtempSync(join(tmpdir(), "cdn-startup-policy-"));
  try {
    for (const required of ["false", "true"]) {
      const child = Bun.spawn(
        ["bun", "--eval", "await import('./src/server/config.ts');console.log('CONFIG_READY');"],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            NODE_ENV: "test",
            HOME: root,
            CODEX_HOME: root,
            PANDA_FORCE_HOME: root,
            PANDA_FORCE_REQUIRE_CDN: required,
            PANDA_FORCE_CDN_BASE_URL: "",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [output, error, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (required === "true") {
        expect(code).not.toBe(0);
        expect(error).toContain("cdnBuildRequired");
        expect(output).not.toContain("CONFIG_READY");
      } else {
        expect(code).toBe(0);
        expect(output).toContain("CONFIG_READY");
      }
      expect(existsSync(join(root, "config", "administrator.json"))).toBe(false);
      expect(existsSync(join(root, "data"))).toBe(false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
