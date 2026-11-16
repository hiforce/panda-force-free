import { mapMetadata, metadataFailure } from "../../../shared/async-value.js";
import type { NativeBuildThemeMetadata } from "../../builds/native/ports.js";
import type { NativeThemeServicePort } from "../native/service.js";
import type { NativeBuildThemes } from "../../builds/native/ports.js";
import type { NativeThemeService } from "../native/service.js";
import { NativeThemeError } from "../../../shared/templates/native/contracts.js";
import { SourceStageError } from "../../../shared/packages/stages/contracts.js";
import { SourceError } from "../../../shared/packages/sources/contracts.js";
import { SiteBuildError } from "../../builds/errors.js";

/** This bridge exposes a selected immutable projection and current authority, never the private original archive. */
export function nativeBuildThemes(service: NativeThemeService): NativeBuildThemes;
export function nativeBuildThemes(service: NativeThemeServicePort): NativeBuildThemeMetadata;
export function nativeBuildThemes(service: NativeThemeServicePort): NativeBuildThemeMetadata {
  function mapped(error: unknown): never {
    if (error instanceof NativeThemeError && ["disabled", "notFound", "immutableVersion"].includes(error.code))
      throw new SiteBuildError("themeNotApproved", 403);
    if (
      (error instanceof SourceStageError && error.code === "stageBusy") ||
      (error instanceof NativeThemeError && error.code === "busy")
    )
      throw new SiteBuildError("inputBusy", 429);
    if (error instanceof SourceError && error.code === "sourceTooLarge")
      throw new SiteBuildError("snapshotTooLarge", 413);
    throw new SiteBuildError("snapshotUnavailable", 503);
  }
  return {
    describe(actor, ref) {
      return metadataFailure(
        () => mapMetadata(service.detail(actor, ref), (theme) => ({ engine: theme.descriptor.settings.engine })),
        mapped,
      );
    },
    authorize(actor, ref) {
      return metadataFailure(() => mapMetadata(service.authorize(actor, ref), () => {}), mapped);
    },
    async with(actor, ref, read) {
      try {
        return await service.source(actor, ref, (theme) =>
          read({ definition: theme.definition(), resources: theme.projection.tree }),
        );
      } catch (error) {
        if (error instanceof SiteBuildError) throw error;
        return mapped(error);
      }
    },
  };
}
