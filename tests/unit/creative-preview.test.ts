import { expect, test } from "bun:test";
import { staticCreativePreview } from "../../src/server/creative/assets/preview.js";

test("static preview retains authored layout but removes scripts, navigation, foreign markup and external resources", () => {
  const result = staticCreativePreview(
    Buffer.from(
      `<html><head><meta http-equiv="refresh" content="0;url=https://external.invalid"><style>h1{color:navy}</style></head><body onload="alert(1)"><h1>Authored layout</h1><script>alert(2)</script><iframe srcdoc="bad"></iframe><img src="https://external.invalid/x"><a href="https://external.invalid" target="_blank">Link</a><svg><script>alert(3)</script></svg><form action="https://external.invalid">Form</form></body></html>`,
    ),
  )!;
  expect(result).toContain("h1{color:navy}");
  expect(result).toContain("Authored layout");
  for (const part of ["<script", "onload", "<iframe", "external.invalid", "<svg", "<form", "_blank", "refresh"])
    expect(result).not.toContain(part);
  expect(result).toContain("default-src 'none'");
  expect(result).toContain("style-src 'unsafe-inline'");
});

test("a preview that exceeds nesting limits is unavailable rather than silently truncated", () => {
  expect(
    staticCreativePreview(Buffer.from("<div>".repeat(140) + "Deep original" + "</div>".repeat(140))),
  ).toBeUndefined();
});
