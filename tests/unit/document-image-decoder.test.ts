import { expect, test } from "bun:test";
import sharp from "sharp";
import { DocumentImageDecoder, MAX_ASSET_BYTES } from "../../src/server/documents/image-decoder.js";

const png = () =>
  sharp({ create: { width: 3, height: 2, channels: 3, background: "#3080c0" } })
    .png()
    .toBuffer();
test("document image validation captures original bytes before decoding and reports actual MIME and dimensions", async () => {
  const bytes = await png(),
    original = Buffer.from(bytes),
    decoder = new DocumentImageDecoder(),
    pending = decoder.decode("diagram.jpg", bytes);
  bytes.fill(0);
  const result = await pending;
  expect(result).toMatchObject({ name: "diagram.jpg", mime: "image/png", width: 3, height: 2, size: original.length });
  expect(result.bytes).toEqual(original);
  expect(result.digest).toBe(new Bun.CryptoHasher("sha256").update(original).digest("hex"));
});
test("image decoding has bounded concurrency and releases slots after both success and failure", async () => {
  const bytes = await png(),
    decoder = new DocumentImageDecoder(),
    first = decoder.decode("one.png", bytes),
    second = decoder.decode("two.png", bytes);
  await expect(decoder.decode("busy.png", bytes)).rejects.toMatchObject({ code: "busy", status: 429 });
  await Promise.all([first, second]);
  await expect(decoder.decode("broken.png", Buffer.from("not an image"))).rejects.toMatchObject({
    code: "invalidImage",
  });
  expect((await decoder.decode("again.png", bytes)).mime).toBe("image/png");
});
test("image validation rejects names, empty uploads, executable formats and oversized inputs before storage", async () => {
  const decoder = new DocumentImageDecoder();
  await expect(decoder.decode("../secret.png", Buffer.from("x"))).rejects.toMatchObject({ code: "invalidInput" });
  await expect(decoder.decode("empty.png", Buffer.alloc(0))).rejects.toMatchObject({
    code: "assetTooLarge",
    status: 413,
  });
  await expect(decoder.decode("large.png", Buffer.alloc(MAX_ASSET_BYTES + 1))).rejects.toMatchObject({
    code: "assetTooLarge",
    status: 413,
  });
  await expect(
    decoder.decode("image.svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="3" height="2"></svg>')),
  ).rejects.toMatchObject({ code: "invalidImage" });
});
