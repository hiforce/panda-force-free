import { slideAssert } from "../../../shared/slides/contracts.js";
import type { NativePresentation } from "./package.js";

export function assertEditableNativeSource(source: NativePresentation): void {
  slideAssert(
    !source.parts.relationships(null).some((ref) => ref.type.includes("/digital-signature/")),
    "unsupportedPackage",
  );
}
