import type { Extension } from "@codemirror/state";
import { StreamLanguage } from "@codemirror/language";
import { documentJava } from "./java.js";
import { cpp } from "@codemirror/lang-cpp";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { python } from "@codemirror/lang-python";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { markdown } from "@codemirror/lang-markdown";
import { rust } from "@codemirror/lang-rust";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { go } from "@codemirror/legacy-modes/mode/go";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { kotlin, csharp, scala } from "@codemirror/legacy-modes/mode/clike";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";

import {
  codeLanguageIdentity,
  codeLanguageLabels,
  type CodeLanguageId,
} from "../../../shared/documents/code-languages.js";

/** Grammars are confined to lazy browser adapters; document metadata cannot select external code. */
const grammars: Readonly<Record<CodeLanguageId, () => Extension>> = {
  plaintext: () => [],
  java: documentJava,
  javascript,
  typescript: () => javascript({ typescript: true }),
  jsx: () => javascript({ jsx: true }),
  tsx: () => javascript({ typescript: true, jsx: true }),
  json,
  python,
  cpp,
  c: cpp,
  csharp: () => StreamLanguage.define(csharp),
  kotlin: () => StreamLanguage.define(kotlin),
  scala: () => StreamLanguage.define(scala),
  go: () => StreamLanguage.define(go),
  rust,
  sql,
  bash: () => StreamLanguage.define(shell),
  powershell: () => StreamLanguage.define(powerShell),
  yaml: () => StreamLanguage.define(yaml),
  html,
  xml,
  css,
  markdown,
  ruby: () => StreamLanguage.define(ruby),
  swift: () => StreamLanguage.define(swift),
  dockerfile: () => StreamLanguage.define(dockerFile),
};
export function documentCodeLanguage(value: unknown) {
  const id = codeLanguageIdentity(value);
  return id ? { id, ...codeLanguageLabels[id]!, syntax: grammars[id]! } : null;
}
