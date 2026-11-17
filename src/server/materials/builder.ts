import { MATERIAL_TEXT_LIMITS as limits, MaterialTextError, type MaterialText } from "./contracts.js";
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
  result(): MaterialText {
    const text = this.parts.join("\n\n");
    if (!text.trim()) throw new MaterialTextError("empty");
    return { text, sections: this.sections };
  }
}
