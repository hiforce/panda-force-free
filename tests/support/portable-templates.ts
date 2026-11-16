import type { PortableTemplateManifest, PortableTemplateIndex } from "../../src/shared/templates/portable/contracts.js";
import { contentSha256 } from "../../src/shared/packages/digest.js";

export interface PortableFixture {
  schemaVersion: number;
  kind: string;
  index: PortableTemplateIndex;
  files: { path: string; encoding: string; data: string }[];
}
export async function portableFixture(): Promise<PortableFixture> {
  return JSON.parse(await Bun.file(new URL("../fixtures/template-library/mixed.bundle.json", import.meta.url)).text());
}
export const fixtureBytes = (value: PortableFixture) => new TextEncoder().encode(JSON.stringify(value));
export async function editPortableFixture(
  value: PortableFixture,
  id: string,
  edit: (manifest: PortableTemplateManifest, payload: Record<string, unknown>) => void,
) {
  const entry = value.index.entries.find((item) => item.id === id)!,
    file = value.files.find((item) => item.path === entry.manifest)!;
  const manifest = JSON.parse(Buffer.from(file.data, "base64").toString()) as PortableTemplateManifest;
  const prefix = entry.manifest.slice(0, entry.manifest.lastIndexOf("/") + 1),
    payloadFile = value.files.find((item) => item.path === prefix + manifest.payload.path)!;
  const payload = JSON.parse(Buffer.from(payloadFile.data, "base64").toString()) as Record<string, unknown>;
  edit(manifest, payload);
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  payloadFile.data = Buffer.from(payloadBytes).toString("base64");
  const declaration = manifest.files.find((item) => item.path === manifest.payload.path)!;
  declaration.bytes = payloadBytes.length;
  declaration.sha256 = await contentSha256(payloadBytes);
  const raw = new TextEncoder().encode(JSON.stringify(manifest));
  file.data = Buffer.from(raw).toString("base64");
  Object.assign(entry, {
    id: manifest.id,
    version: manifest.version,
    templateType: manifest.templateType,
    categories: manifest.categories,
    name: manifest.name,
    description: manifest.description,
    sha256: await contentSha256(raw),
  });
}
