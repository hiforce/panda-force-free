import type { SourceUploadBody } from "../../src/server/packages/uploads/contracts.js";
import { openZipSource } from "../../src/server/packages/zip/source.js";
import { captureSourceSnapshot } from "../../src/shared/packages/sources/snapshot.js";
import type { PackageSourceStages } from "../../src/server/packages/staging/service.js";
import type { SourceStageAcquisition } from "../../src/server/packages/staging/ports.js";

export function uploadBody(bytes: Uint8Array, chunkBytes = 32768) {
  const state = { produced: 0, cancelled: 0 };
  const body: SourceUploadBody = {
    chunks: {
      async *[Symbol.asyncIterator]() {
        for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
          state.produced++;
          yield bytes.subarray(offset, offset + chunkBytes);
        }
      },
    },
    cancel() {
      state.cancelled++;
    },
  };
  return { body, state };
}
export function captureUploaded(stages: PackageSourceStages, id: string): SourceStageAcquisition {
  return async (actor, _purpose, request, signal, limits) => {
    if (request.source.kind !== "zip-upload") throw Error("Expected uploaded ZIP source");
    const bytes = await stages.original(actor, id, signal),
      reader = await openZipSource(bytes, request.source.name, limits, signal);
    return captureSourceSnapshot(reader, request.selected ?? undefined, bytes, limits, signal);
  };
}
