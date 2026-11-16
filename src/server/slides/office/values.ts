import { slideAssert } from "../../../shared/slides/contracts.js";
import type { XmlElement } from "../../packages/opc/xml.js";

export function officeInteger(value: string | null): number {
  slideAssert(value !== null && /^[+-]?\d{1,18}$/.test(value));
  const number = Number(value);
  slideAssert(Number.isSafeInteger(number));
  return number;
}
export function drawingId(value: string | null): string {
  const number = officeInteger(value);
  slideAssert(number >= 0 && number <= 0xffffffff);
  return String(number);
}
export function officeBoolean(element: XmlElement, attribute: string): boolean {
  const value = element.getAttribute(attribute);
  slideAssert(value === null || ["1", "0", "true", "false"].includes(value));
  return value === "1" || value === "true";
}
export function officeLabel(value: string | null, fallback = ""): string {
  const text = value ?? fallback;
  slideAssert(text.length <= 8192 && !/[\p{Cs}]/u.test(text), "limitExceeded");
  return text;
}
