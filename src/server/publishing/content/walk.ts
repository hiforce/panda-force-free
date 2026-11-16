import type { ContentBlock, ContentIR, Inline } from "../../../shared/publishing/content.js";

export function walkBlocks(blocks: ContentBlock[], visit: (block: ContentBlock) => void) {
  for (const block of blocks) {
    visit(block);
    if (block.kind === "quote" || block.kind === "container") walkBlocks(block.children, visit);
    if (block.kind === "list") for (const item of block.items) walkBlocks(item.children, visit);
    if (block.kind === "grid") for (const row of block.rows) for (const cell of row) walkBlocks(cell.children, visit);
  }
}
export function contentImages(ir: ContentIR): { source: string; alt: string; blockId: string }[] {
  const images: { source: string; alt: string; blockId: string }[] = [];
  const inline = (items: Inline[], blockId: string) => {
    for (const item of items) {
      if (item.kind === "image") images.push({ source: item.source, alt: item.alt, blockId });
      if ("children" in item) inline(item.children, blockId);
    }
  };
  walkBlocks(ir.blocks, (block) => {
    if (block.kind === "image") images.push({ source: block.source, alt: block.alt, blockId: block.id });
    if ("inline" in block) inline(block.inline, block.id);
    if (block.kind === "container" && block.image) images.push({ ...block.image, blockId: block.id });
    if (block.kind === "table")
      for (const row of [block.header, ...block.rows]) for (const cell of row) inline(cell, block.id);
  });
  return images;
}
export function localAssetId(source: string): string | null {
  return (
    /^\/api\/document-assets\/content\?id=([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.exec(
      source,
    )?.[1] || null
  );
}
