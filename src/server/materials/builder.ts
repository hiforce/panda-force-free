import { MATERIAL_TEXT_LIMITS as limits, MaterialTextError, type DetailedMaterialText } from "./contracts.js";
/** Bounded assembly avoids silently accepting a truncated source. */
export class MaterialTextBuilder {
  private parts: string[] = [];
  private bytes = 0;
  private sections = 0;
  add(text: string) {
    if (text.includes("\0")) throw new MaterialTextError("unreadable");
    this.bytes += Buffer.byteLength(text) + 2;
    if (this.bytes > limits.textBytes) throw new MaterialTextError("tooLarge");
    this.parts.push(text);
    this.sections++;
  }
  result(): DetailedMaterialText {
    const text = this.parts.join("\n\n");
    if (!text.trim()) throw new MaterialTextError("empty");
    const offsets: number[] = [];
    let offset = 0;
    for (const part of this.parts) {
      offsets.push(offset);
      offset += part.length + 2;
    }
    return { text, offsets, sections: this.sections };
  }
}
