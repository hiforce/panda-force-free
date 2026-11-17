/** Narrow text-only contract for the pinned generated parser. */
interface PdfPage {
  getTextContent(): Promise<{ items: { str?: string; hasEOL?: boolean }[] }>;
  cleanup(): void;
}
interface PdfDocument {
  numPages: number;
  getPage(index: number): Promise<PdfPage>;
  loadingTask: { destroy(): Promise<void> };
}
export function getDocumentProxy(data: Uint8Array, options?: Record<string, unknown>): Promise<PdfDocument>;
