import { extname } from "node:path";
import { SourceError } from "../../shared/packages/sources/contracts.js";
import { OfficePresentationError } from "../../shared/slides/contracts.js";
import { OpcError } from "../packages/opc/errors.js";
import {
  MATERIAL_TEXT_LIMITS as limits,
  MaterialTextError,
  type MaterialText,
  type DetailedMaterialText,
} from "./contracts.js";
import { pdfMaterialText } from "./pdf.js";
import { wordMaterialText, workbookMaterialText, presentationMaterialText } from "./office.js";
export async function extractMaterialText(name: string, bytes: Uint8Array): Promise<MaterialText> {
  const { text, sections } = await extractMaterialSections(name, bytes);
  return { text, sections };
}

export async function extractMaterialSections(name: string, bytes: Uint8Array): Promise<DetailedMaterialText> {
  if (!(bytes instanceof Uint8Array) || bytes.length > limits.inputBytes) throw new MaterialTextError("tooLarge");
  const format = extname(name).toLowerCase(),
    parsers: Record<string, (bytes: Uint8Array) => Promise<DetailedMaterialText>> = {
      ".pdf": pdfMaterialText,
      ".docx": wordMaterialText,
      ".xlsx": workbookMaterialText,
      ".pptx": presentationMaterialText,
    };
  const parser = parsers[format];
  if (!parser) throw new MaterialTextError("unsupported");
  if (format !== ".pdf" && Buffer.from(bytes.subarray(0, 8)).toString("hex") === "d0cf11e0a1b11ae1")
    throw new MaterialTextError("encrypted");
  try {
    return await parser(bytes);
  } catch (error) {
    if (error instanceof MaterialTextError) throw error;
    if (
      (error instanceof SourceError && error.code === "sourceTooLarge") ||
      (error instanceof OpcError && error.code === "xmlLimitExceeded") ||
      (error instanceof OfficePresentationError && error.code === "limitExceeded")
    )
      throw new MaterialTextError("tooLarge");
    throw new MaterialTextError("unreadable");
  }
}
