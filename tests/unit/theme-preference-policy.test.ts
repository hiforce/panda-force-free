import { describe, expect, test } from "bun:test";
import { resolveThemePreference } from "../../src/client/theme.js";

describe("appearance preference compatibility", () => {
  test("follows the operating system only for a system preference", () => {
    expect(resolveThemePreference("system", false)).toMatchObject({
      preference: "system",
      theme: "light",
      appearance: "light",
    });
    expect(resolveThemePreference("system", true)).toMatchObject({
      preference: "system",
      theme: "dark",
      appearance: "graphite",
    });
    expect(resolveThemePreference("light", true).theme).toBe("light");
    expect(resolveThemePreference("dark", false).theme).toBe("dark");
  });

  test("restores legacy dark preferences while keeping preset-specific surfaces", () => {
    expect(resolveThemePreference("dark", false)).toMatchObject({ preference: "dark", appearance: "graphite" });
    expect(resolveThemePreference("silk", true)).toMatchObject({
      preference: "silk",
      theme: "light",
      appearance: "silk",
    });
    expect(resolveThemePreference("aurora", false)).toMatchObject({
      preference: "aurora",
      theme: "dark",
      appearance: "aurora",
    });
  });

  test("invalid stored values fall back to the current system scheme", () => {
    expect(resolveThemePreference("unknown", true)).toMatchObject({ preference: "system", theme: "dark" });
    expect(resolveThemePreference(null, false)).toMatchObject({ preference: "system", theme: "light" });
  });
});
