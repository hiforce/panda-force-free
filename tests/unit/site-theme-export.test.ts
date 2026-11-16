import { expect, test } from "bun:test";
import { builtinSiteThemes } from "../../src/shared/presentation/themes.js";
import { copySiteTheme } from "../../src/client/publishing-styles/catalog.js";
import { verifyPluginPackage } from "../../src/shared/plugins/package.js";
import type { Translate } from "../../src/shared/i18n/messages.js";

const t: Translate = (id) => id;
test("every built-in site style copies to a portable data-only package without mutating the catalog", async () => {
  for (const original of builtinSiteThemes.list("markdown")) {
    const before = structuredClone(original),
      value = copySiteTheme(original, t);
    const verified = await verifyPluginPackage(value);
    expect(verified.package.manifest.permissions).toEqual(["content:site-themes"]);
    expect(value.files).toEqual([]);
    expect(value.manifest.siteThemes[0]).toMatchObject({
      kind: "profile",
      engine: original.engine,
      profile: original.profile,
    });
    expect(original).toEqual(before);
    value.manifest.siteThemes[0]!.name = "An edited name";
    expect(original).toEqual(before);
  }
});
