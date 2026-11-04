import { resolve } from "node:path";
import { verifySnapshot } from "./snapshot-lib.mjs";
import { auditComments } from "./comment-audit.mjs";
const args = process.argv.slice(2),
  index = args.indexOf("--dir");
if (index < 0 || !args[index + 1])
  throw new Error("Usage: bun scripts/release/verify-free.mjs --dir SNAPSHOT_DIRECTORY");
const root = resolve(args[index + 1]),
  snapshot = verifySnapshot(root);
const comments = auditComments(
  snapshot.files
    .filter((file) => /\.(?:js|ts|mjs|cjs|css|html|svg|py|sh|yaml|yml)$/.test(file.path))
    .map((file) => file.path),
  root,
);
if (comments.findings.length || comments.errors.length)
  throw new Error("Comment audit failed: " + JSON.stringify(comments));
console.log(
  JSON.stringify(
    {
      verified: true,
      contentSha256: snapshot.contentSha256,
      files: snapshot.files.length,
      comments: comments.comments,
    },
    null,
    2,
  ),
);
