import type { ContentIR, ContentVariant } from "../../../../shared/publishing/content.js";
import { contentImages, walkBlocks } from "../../content/walk.js";

/** Attach each source occurrence once, beside its text. Additional Thread images get separate reviewed posts. */
export function postMedia(ir: ContentIR, posts: ContentVariant["posts"], thread: boolean): ContentVariant["posts"] {
  const parents = new Map<string, string>();
  for (const block of ir.blocks) walkBlocks([block], (child) => parents.set(child.id, block.id));
  const order = new Map(ir.blocks.map((block, index) => [block.id, index]));
  const result = posts.map((post) => ({ ...post, imageIndexes: [] as number[] }));
  if (!result.length) return result;
  contentImages(ir).forEach((image, index) => {
    const top = parents.get(image.blockId) || image.blockId;
    let position = result.findIndex((post) => post.sourceBlockIds.includes(top));
    if (position < 0)
      position = result.findIndex((post) =>
        post.sourceBlockIds.some((id) => (order.get(id) ?? -1) >= (order.get(top) ?? 0)),
      );
    if (position < 0) position = result.length - 1;
    result[position]!.imageIndexes.push(index);
  });
  if (!thread) return result;
  return result.flatMap((post) => {
    const groups = [{ ...post, imageIndexes: post.imageIndexes.slice(0, 4) }];
    for (let i = 4; i < post.imageIndexes.length; i += 4)
      groups.push({
        ...post,
        text: "",
        weightedLength: 0,
        valid: true,
        imageIndexes: post.imageIndexes.slice(i, i + 4),
      });
    return groups;
  });
}
