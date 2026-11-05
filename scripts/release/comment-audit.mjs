import { verificationFiles } from "../verification/source.js";
import { tokenizer } from "acorn";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";

// Tokenize comments instead of confusing translated UI strings with comments.
export function auditComments(files, root = process.cwd()) {
  const findings = [],
    errors = [];
  let comments = 0;
  const inspect = (file, value, line) => {
    comments++;
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Cyrillic}\p{Script=Arabic}]/u.test(value))
      findings.push({ file, line, text: value.trim() });
  };
  for (const file of files) {
    const extension = extname(file),
      source = readFileSync(root + "/" + file, "utf8");
    try {
      if ([".js", ".ts", ".mjs", ".cjs"].includes(extension)) {
        const stream = tokenizer(source, {
          ecmaVersion: "latest",
          sourceType: "module",
          allowHashBang: true,
          onComment: (_block, value, start) => inspect(file, value, source.slice(0, start).split("\n").length),
        });
        while (stream.getToken().type.label !== "eof") {
          /* Consume tokens so the parser visits every comment. */
        }
      } else if ([".css", ".html", ".svg"].includes(extension)) {
        const pattern = extension === ".css" ? /\/\*([\s\S]*?)\*\//g : /<!--([\s\S]*?)-->/g;
        for (const match of source.matchAll(pattern))
          inspect(file, match[1], source.slice(0, match.index).split("\n").length);
      } else if ([".py", ".sh", ".yaml", ".yml"].includes(extension) || file.endsWith("Dockerfile")) {
        for (const [index, line] of source.split("\n").entries())
          if (/^\s*#/.test(line)) inspect(file, line, index + 1);
      }
    } catch (error) {
      errors.push({ file, error: error.message });
    }
  }
  return { files: files.length, comments, findings, errors };
}
if (import.meta.main) {
  const manifestFiles =
    !existsSync(".git") && existsSync("SNAPSHOT.json")
      ? JSON.parse(readFileSync("SNAPSHOT.json", "utf8")).files.map((entry) => entry.path)
      : null;
  const files = (
    manifestFiles ||
    (!existsSync(".git")
      ? verificationFiles()
      : execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
          encoding: "utf8",
        }).split("\0"))
  )
    .filter((path) => existsSync(path))
    .filter(
      (file) =>
        (/^(src|public|scripts|deploy|tests|panda-docs|release\/community)\//.test(file) ||
          ["Dockerfile", "eslint.config.mjs", "prettier.config.mjs"].includes(file)) &&
        (/\.(?:js|ts|mjs|cjs|css|html|svg|py|sh|yaml|yml)$/.test(file) || file.endsWith("Dockerfile")),
    );
  const result = auditComments([...new Set(files)]);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.findings.length || result.errors.length ? 1 : 0;
}
