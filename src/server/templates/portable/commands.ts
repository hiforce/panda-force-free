import { PortableRegistryError } from "./errors.js";
import { templateObject } from "../../../shared/templates/portable/validation.js";

export function portableSelectionKeys(selected: unknown) {
  if (
    !Array.isArray(selected) ||
    !selected.length ||
    selected.length > 256 ||
    selected.some((key) => typeof key !== "string") ||
    new Set(selected).size !== selected.length
  )
    throw new PortableRegistryError("invalidInput");
  return [...selected].sort() as string[];
}

export interface PortableInstallApproval {
  readonly operationId: string;
  readonly expectedRevision: number;
  readonly reviewHash: string;
  readonly selected: readonly string[];
}
export function portableInstallApproval(value: unknown): PortableInstallApproval {
  const input = templateObject(value, ["operationId", "expectedRevision", "reviewHash", "selected"]);
  portableRevision(input.expectedRevision);
  if (
    typeof input.reviewHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.reviewHash) ||
    typeof input.operationId !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.operationId)
  )
    throw new PortableRegistryError("invalidInput");
  return Object.freeze({
    operationId: input.operationId,
    expectedRevision: input.expectedRevision,
    reviewHash: input.reviewHash,
    selected: Object.freeze(portableSelectionKeys(input.selected)),
  });
}

export function portableActor(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 240 || /[\p{Cc}\p{Cf}]/u.test(value))
    throw new PortableRegistryError("invalidInput");
}
export function portableRevision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new PortableRegistryError("invalidInput");
}
