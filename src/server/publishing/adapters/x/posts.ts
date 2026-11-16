import twitterText from "twitter-text";
const { extractUrlsWithIndices, parseTweet } = twitterText;
import type { ContentIR, ContentVariant } from "../../../../shared/publishing/content.js";
import { plainBlock } from "../../content/render.js";
import { PublicationError } from "../../errors.js";
import { postMedia } from "./post-media.js";

export function countPost(text: string) {
  const parsed = parseTweet(text.normalize("NFC"));
  return { weightedLength: parsed.weightedLength, valid: parsed.valid };
}
interface Unit {
  text: string;
  blockId: string;
}
function words(text: string, blockId: string): Unit[] {
  const units: Unit[] = [];
  let cursor = 0;
  const add = (part: string) => {
    for (const match of part.matchAll(/\S+\s*|\s+/gu)) units.push({ text: match[0], blockId });
  };
  for (const url of extractUrlsWithIndices(text)) {
    add(text.slice(cursor, url.indices[0]));
    units.push({ text: text.slice(...url.indices), blockId });
    cursor = url.indices[1];
  }
  add(text.slice(cursor));
  return units;
}
/** Thread composition is explicit and lossless in text; URLs and grapheme clusters are indivisible. */
export function composePosts(ir: ContentIR, thread: boolean): ContentVariant["posts"] {
  const sections = [
    { text: ir.title, id: "title" },
    ...ir.blocks.map((block) => ({ text: plainBlock(block), id: block.id })),
  ];
  const text = sections
    .map((section) => section.text)
    .join("\n\n")
    .normalize("NFC")
    .trim();
  if (!thread)
    return postMedia(ir, [{ text, ...countPost(text), sourceBlockIds: sections.map((section) => section.id) }], false);
  if (countPost(text).weightedLength > 27_000) throw new PublicationError("threadTooLong", 413);
  const budget = 270,
    chunks: { text: string; ids: Set<string> }[] = [];
  let current = "",
    ids = new Set<string>();
  const flush = () => {
    if (current.trim()) chunks.push({ text: current.trim(), ids });
    current = "";
    ids = new Set();
  };
  const append = (value: string, id: string) => {
    current += value;
    ids.add(id);
  };
  const graphemes = new Intl.Segmenter(ir.locale, { granularity: "grapheme" });
  for (const section of sections) {
    for (const unit of words(section.text.normalize("NFC") + "\n\n", section.id)) {
      if (countPost((current + unit.text).trim()).weightedLength <= budget) {
        append(unit.text, unit.blockId);
        continue;
      }
      flush();
      if (countPost(unit.text.trim()).weightedLength <= budget) {
        append(unit.text.trimStart(), unit.blockId);
        continue;
      }
      const pieces = [...graphemes.segment(unit.text)].map((item) => item.segment);
      let start = 0;
      while (start < pieces.length) {
        let low = start + 1,
          high = pieces.length,
          end = start;
        while (low <= high) {
          const middle = Math.floor((low + high) / 2);
          if (countPost(pieces.slice(start, middle).join("").trim()).weightedLength <= budget) {
            end = middle;
            low = middle + 1;
          } else high = middle - 1;
        }
        if (end === start) throw new PublicationError("threadTooLong", 413);
        append(pieces.slice(start, end).join(""), unit.blockId);
        start = end;
        if (start < pieces.length) flush();
      }
    }
  }
  flush();
  const withImages = postMedia(
    ir,
    chunks.map((chunk) => ({ text: chunk.text, ...countPost(chunk.text), sourceBlockIds: [...chunk.ids] })),
    true,
  );
  if (withImages.length > 100) throw new PublicationError("threadTooLong", 413);
  return withImages.map((post, index) => {
    const text = `${index + 1}/${withImages.length}\n\n${post.text}`.trimEnd();
    return { ...post, text, ...countPost(text) };
  });
}
