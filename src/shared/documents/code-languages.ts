/** Language identities are exchange metadata; grammar implementations belong to browser runtime adapters. */
const definitions = {
  plaintext: { label: "Plain text", aliases: ["text", "txt", "plain", ""] },
  java: { label: "Java", aliases: [] },
  javascript: { label: "JavaScript", aliases: ["js"] },
  typescript: { label: "TypeScript", aliases: ["ts"] },
  jsx: { label: "JSX", aliases: [] },
  tsx: { label: "TSX", aliases: [] },
  json: { label: "JSON", aliases: ["jsonc"] },
  python: { label: "Python", aliases: ["py"] },
  cpp: { label: "C++", aliases: ["c++", "cc", "cxx"] },
  c: { label: "C", aliases: [] },
  csharp: { label: "C#", aliases: ["c#", "cs"] },
  kotlin: { label: "Kotlin", aliases: ["kt"] },
  scala: { label: "Scala", aliases: [] },
  go: { label: "Go", aliases: ["golang"] },
  rust: { label: "Rust", aliases: ["rs"] },
  sql: { label: "SQL", aliases: [] },
  bash: { label: "Shell / Bash", aliases: ["sh", "shell", "zsh"] },
  powershell: { label: "PowerShell", aliases: ["ps1"] },
  yaml: { label: "YAML", aliases: ["yml"] },
  html: { label: "HTML", aliases: ["htm"] },
  xml: { label: "XML", aliases: ["svg"] },
  css: { label: "CSS", aliases: [] },
  markdown: { label: "Markdown", aliases: ["md", "mdown"] },
  ruby: { label: "Ruby", aliases: ["rb"] },
  swift: { label: "Swift", aliases: [] },
  dockerfile: { label: "Dockerfile", aliases: ["docker"] },
};
export type CodeLanguageId = keyof typeof definitions;
export const codeLanguageLabels: Readonly<Record<CodeLanguageId, { label: string; aliases: readonly string[] }>> =
  definitions;
export function codeLanguageIdentity(value: unknown): CodeLanguageId | null {
  const name = typeof value === "string" ? value.toLowerCase() : "";
  return (
    (Object.keys(codeLanguageLabels) as CodeLanguageId[]).find(
      (id) => id === name || codeLanguageLabels[id]!.aliases.includes(name),
    ) ?? null
  );
}
