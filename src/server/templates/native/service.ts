import type { NativeThemeSnapshot, InstalledNativeTheme } from "../../../shared/templates/native/contracts.js";
import { mapMetadata, type MetadataStore, type MetadataValue } from "../../../shared/async-value.js";
import type { OwnedSourceMetadata } from "../../packages/ownership/ports.js";
import { contentSha256 } from "../../../shared/packages/digest.js";
import { NativeSiteTheme } from "../../../shared/templates/native/package.js";
import {
  NativeThemeError,
  type NativeThemeIntent,
  type NativeThemeReview,
} from "../../../shared/templates/native/contracts.js";
import type { NativeThemeRegistry } from "./ports.js";
import type { TemplateSourceReader, TemplateSourceConsumer } from "../sources/ports.js";
import {
  nativeActor,
  nativeInstallCommand,
  nativeThemeReference,
  nativeRevision,
  nativeSourceSelection,
} from "./commands.js";
import { templateObject, templateChoice } from "../../../shared/templates/portable/validation.js";
import { nativeThemeProposal } from "./proposal.js";
import { NativeThemeOperations } from "./operations.js";
import { readNativeThemeBundle } from "../../../shared/templates/native/bundle.js";
import { exportNativeTheme } from "./export.js";
/** Source reads, frozen install intents and metadata publication have separate ownership boundaries. */
export class NativeThemeService<S extends MetadataStore<NativeThemeRegistry> = NativeThemeRegistry> {
  private operations = new NativeThemeOperations();
  constructor(
    private registry: S,
    private sources: OwnedSourceMetadata,
    private reader: TemplateSourceReader,
    private consumer: TemplateSourceConsumer,
    private now = Date.now,
  ) {}
  snapshot(actor: string): MetadataValue<S, NativeThemeRegistry, NativeThemeSnapshot> {
    nativeActor(actor);
    return this.registry.snapshot(actor) as MetadataValue<S, NativeThemeRegistry, NativeThemeSnapshot>;
  }
  prepare(actor: string, value: unknown) {
    nativeActor(actor);
    const input = templateObject(value, ["source", "engine"]),
      source = nativeSourceSelection(input.source),
      engine = templateChoice(input.engine, ["hexo", "docusaurus"]);
    return this.operations.run(() =>
      this.reader.project(actor, source.id, async (captured) => {
        if (captured.digest !== source.sha256) throw new NativeThemeError("reviewChanged");
        const bundle = readNativeThemeBundle(captured, source.root);
        if (bundle) {
          if (bundle.settings.engine !== engine) throw new NativeThemeError("invalidInput");
          const settings = bundle.settings;
          return {
            settings,
            bundle: bundle.provenance,
            licenseFiles: [settings.license.file],
            licenseText: captured.tree.text(settings.license.file, 256 * 1024),
            readmeText: settings.readme ? captured.tree.text(settings.readme, 512 * 1024) : "",
            issues: [],
          };
        }
        return nativeThemeProposal(captured, source.root, engine);
      }),
    );
  }
  private async reviewValue(actor: string, value: NativeSiteTheme): Promise<NativeThemeReview> {
    const snapshot = await this.registry.snapshot(actor),
      data = value.descriptor.data,
      prior = snapshot.themes.find((theme) => theme.id === data.settings.id && theme.version === data.settings.version);
    if (prior && prior.digest !== value.digest) throw new NativeThemeError("immutableVersion");
    const requiredPermissions = ["build:theme-code"] as const,
      reviewHash = await contentSha256(
        JSON.stringify({ revision: snapshot.revision, digest: value.digest, requiredPermissions }),
      );
    return {
      revision: snapshot.revision,
      reviewHash,
      digest: value.digest,
      descriptor: data,
      licenseText: value.source.tree.text(data.license.path, 256 * 1024),
      sourceFiles: value.source.tree.files.length + (value.source.links?.files.length ?? 0),
      installed: !!prior,
      requiredPermissions,
    };
  }
  review(actor: string, input: unknown) {
    nativeActor(actor);
    const command = nativeInstallCommand(input, false);
    return this.operations.run(() =>
      this.reader.project(actor, command.source.id, async (source) => {
        if (source.digest !== command.source.sha256) throw new NativeThemeError("reviewChanged");
        return this.reviewValue(actor, await NativeSiteTheme.create(source, command.source.root, command.settings));
      }),
    );
  }
  async install(actor: string, input: unknown) {
    nativeActor(actor);
    const command = nativeInstallCommand(input, true),
      approval = command.approval!;
    return this.operations.run(async () => {
      const signature = await contentSha256(
        JSON.stringify({
          source: { sha256: command.source.sha256, root: command.source.root },
          settings: command.settings,
          approval,
        }),
      );
      return this.operations.command(JSON.stringify([actor, approval.operationId]), signature, async () => {
        const previous = await this.registry.operation(actor, approval.operationId);
        if (previous) {
          if (previous.signature !== signature) throw new NativeThemeError("conflict");
          return this.resume(previous);
        }
        return this.consumer.consume(actor, command.source.id, command.source.sha256, async (source) => {
          const value = await NativeSiteTheme.create(source, command.source.root, command.settings),
            review = await this.reviewValue(actor, value);
          if (review.revision !== approval.expectedRevision || review.reviewHash !== approval.reviewHash)
            throw new NativeThemeError("reviewChanged");
          const settingsDigest = await contentSha256(JSON.stringify(command.settings)),
            intent = await this.registry.reserve(actor, signature, value.descriptor, approval, settingsDigest);
          if (intent.state === "committed") return await this.result(actor, intent);
          try {
            const owned = await this.sources.save(actor, approval.operationId, value.source);
            await this.registry.commit(actor, approval.operationId, owned);
            return await this.result(actor, (await this.registry.operation(actor, approval.operationId))!);
          } catch (error) {
            await this.failed(intent, error);
            throw error;
          }
        });
      });
    });
  }
  private async result(actor: string, intent: NativeThemeIntent) {
    if (intent.state !== "committed" || !intent.receipt) throw new NativeThemeError("conflict");
    return { receipt: intent.receipt, current: await this.registry.snapshot(actor) };
  }
  private async failed(intent: NativeThemeIntent, error: unknown) {
    if (error instanceof NativeThemeError && error.code === "busy") return;
    await this.registry.fail(intent.actor, intent.operationId);
    await this.cleanup(intent.actor, intent.operationId);
  }
  private async cleanup(actor: string, id: string) {
    const operation = await this.registry.operation(actor, id);
    if (operation?.state !== "failed") return;
    const source = await this.sources.find(actor, id);
    if (source && (await this.registry.referenced(actor, source.ref.id))) return;
    await this.sources.remove(actor, id);
    await this.registry.cleanupDone(actor, id);
  }
  private async resume(intent: NativeThemeIntent) {
    if (intent.state === "committed") return await this.result(intent.actor, intent);
    if (intent.state !== "pending" || !intent.descriptor) throw new NativeThemeError("conflict");
    try {
      const source = await this.sources.recover(intent.actor, intent.operationId);
      if (!source) throw new NativeThemeError(this.now() < intent.recoverAfter ? "busy" : "unavailable");
      await this.sources.with(intent.actor, source, async (captured) => {
        const value = await NativeSiteTheme.create(captured, intent.descriptor!.root, intent.descriptor!.settings);
        if (value.digest !== intent.digest) throw new NativeThemeError("reviewChanged");
        await this.registry.commit(intent.actor, intent.operationId, source);
      });
      return await this.result(intent.actor, (await this.registry.operation(intent.actor, intent.operationId))!);
    } catch (error) {
      await this.failed(intent, error);
      throw error;
    }
  }
  async recover() {
    return this.operations.run(async () => {
      for (const intent of await this.registry.recoverable()) {
        try {
          if (intent.state === "failed") await this.cleanup(intent.actor, intent.operationId);
          else
            await this.operations.command(JSON.stringify([intent.actor, intent.operationId]), intent.signature, () =>
              this.resume(intent),
            );
        } catch (error) {
          if (!(
            error instanceof NativeThemeError &&
            ["busy", "conflict", "unavailable", "reviewChanged"].includes(error.code)
          ))
            throw error;
        }
      }
    });
  }
  detail(actor: string, input: unknown): MetadataValue<S, NativeThemeRegistry, InstalledNativeTheme> {
    nativeActor(actor);
    const ref = nativeThemeReference(input);
    return mapMetadata(this.registry.detail(actor, ref.id, ref.version), (theme) => {
      if (theme.digest !== ref.digest) throw new NativeThemeError("immutableVersion");
      return theme;
    }) as MetadataValue<S, NativeThemeRegistry, InstalledNativeTheme>;
  }
  source<T>(actor: string, input: unknown, run: (theme: NativeSiteTheme) => Promise<T>) {
    return this.operations.run(async () => {
      const theme = await this.detail(actor, input),
        source = await this.registry.source(actor, theme.id, theme.version);
      return this.sources.with(actor, source, async (captured) => {
        const value = await NativeSiteTheme.create(captured, theme.descriptor.root, theme.descriptor.settings);
        if (value.digest !== theme.digest) throw new NativeThemeError("unavailable");
        return run(value);
      });
    });
  }
  async export<T>(
    actor: string,
    input: unknown,
    send: (value: Awaited<ReturnType<typeof exportNativeTheme>>) => Promise<T>,
  ) {
    return this.source(actor, input, async (theme) => send(await exportNativeTheme(theme)));
  }
  state(
    actor: string,
    input: unknown,
    action: "enable" | "disable" | "activate",
    revision: unknown,
  ): MetadataValue<S, NativeThemeRegistry, InstalledNativeTheme> {
    return mapMetadata(this.detail(actor, input), (theme) =>
      this.registry.state(actor, theme.id, theme.version, theme.digest, action, nativeRevision(revision)),
    ) as MetadataValue<S, NativeThemeRegistry, InstalledNativeTheme>;
  }
  authorize(actor: string, input: unknown): MetadataValue<S, NativeThemeRegistry, InstalledNativeTheme> {
    return mapMetadata(this.detail(actor, input), (theme) => {
      if (!theme.enabled) throw new NativeThemeError("disabled");
      return theme;
    }) as MetadataValue<S, NativeThemeRegistry, InstalledNativeTheme>;
  }
  close() {
    return this.operations.close();
  }
}
export type NativeThemeServicePort = NativeThemeService<MetadataStore<NativeThemeRegistry>>;
