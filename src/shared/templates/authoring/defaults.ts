import type { DocumentTemplateDefinition } from "./contracts.js";
import { emptyRichBody } from "../../documents/rich-body.js";

/** A private draft does not silently grant a distribution license; its author can select a license before release. */
export function emptyDocumentTemplate(id: string): DocumentTemplateDefinition {
  return {
    id,
    version: "1.0.0",
    name: {
      en: "Untitled writing skill",
      "zh-CN": "未命名写作技能",
      "zh-HK": "未命名寫作技能",
      "zh-TW": "未命名寫作技能",
    },
    description: {
      en: "Reusable document structure.",
      "zh-CN": "可复用的文档结构。",
      "zh-HK": "可重用的文件結構。",
      "zh-TW": "可重複使用的文件結構。",
    },
    publisher: { name: "Local author" },
    license: {
      expression: "LicenseRef-Private",
      text: "All rights reserved. This skill is for private use unless its author supplies another license.",
    },
    categories: ["writing"],
    tags: [],
    parameters: [],
    contentSlots: [],
    instructions: "",
    body: emptyRichBody(),
    images: [],
  };
}
