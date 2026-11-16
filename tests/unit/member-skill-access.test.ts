import { expect, test } from "bun:test";
import { memberApiAllowed } from "../../src/server/auth/users/access.js";

test("members can read picker metadata while package administration stays restricted", () => {
  for (const path of ["/api/skill-workspace", "/api/skill-packs/detail", "/api/skill-packs/cover"]) {
    expect(memberApiAllowed(path, "GET")).toBe(true);
    expect(memberApiAllowed(path, "POST")).toBe(false);
  }
  for (const path of ["/api/skill-packs/install", "/api/skill-packs/activate", "/api/skill-workspace/commands"])
    expect(memberApiAllowed(path, "POST")).toBe(false);
});
