import { FileCapturedSources } from "../../src/server/packages/captures/content.js";

// A fresh process proves that a captured source does not retain an in-memory provider or credential dependency.
const value = await new FileCapturedSources(process.argv[2]!).read(process.argv[3]!);
console.log(
  JSON.stringify({
    digest: value.digest,
    treeDigest: value.tree.digest,
    paths: value.tree.files.map((file) => file.path),
    inventory: value.descriptor.inventory.files.map((file) => file.path),
    original: Buffer.from(value.readArchive()!).toString("base64"),
    content: value.tree.text("theme/layout/index.ejs"),
  }),
);
