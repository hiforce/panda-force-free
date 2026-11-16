export interface NativeContentSlot {
  readonly id: string;
  readonly label: string;
  readonly kind: "text" | "image";
  readonly target: { readonly part: string; readonly shapeId: string };
  readonly required: boolean;
}
export interface NativeContentMapping {
  readonly schema: "panda.powerpoint-mapping/v1";
  readonly sourceSha256: string;
  readonly slots: readonly NativeContentSlot[];
}
export type NativeSlotValue =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "image"; readonly mediaType: "image/png" | "image/jpeg"; readonly bytes: Uint8Array };
export type NativeContentValues = Readonly<Record<string, NativeSlotValue>>;
export interface NativeLayoutPage {
  readonly layout: string;
  readonly values: NativeContentValues;
}
