import { marked } from "marked";
import { presentationPreviewFrame } from "../presentation-preview.js";

export function previewSkill(host: HTMLElement, content: string, title: string) {
  presentationPreviewFrame(
    host,
    `<main style="font:16px/1.8 system-ui,sans-serif;padding:24px;max-width:760px;margin:auto">${marked.parse(content, { async: false })}</main>`,
    title,
  );
}
