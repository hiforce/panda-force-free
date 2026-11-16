import { expect, test } from "bun:test";
import { templateImportFormat } from "../../src/client/templates/import-file.js";

test("native source archives and PowerPoint files enter source review while JSON retains template review", async () => {
  for (const name of ["theme.zip", "theme.ZIP", "brand.pptx", "brand.potx", "brand.pptm", "brand.potm"])
    expect(await templateImportFormat(new File(["bounded source bytes"], name))).toBe("archive");
  for (const signature of [
    [0x50, 0x4b, 3, 4],
    [0x50, 0x4b, 5, 6],
    [0x50, 0x4b, 7, 8],
  ])
    expect(await templateImportFormat(new File([new Uint8Array(signature)], "download.bin"))).toBe("archive");
  expect(await templateImportFormat(new File(['{"schema":1}'], "template.json"))).toBe("json");
  expect(await templateImportFormat(new File(["PK ordinary text"], "template.json"))).toBe("json");
});
