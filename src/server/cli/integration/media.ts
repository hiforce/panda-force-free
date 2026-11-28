import type { CliCommandId } from "../../../shared/cli/commands.js";
import { CliError } from "../../../shared/cli/contracts.js";
import { CreationError } from "../../creation/contracts.js";
import { MediaExecutorError, type CreationMediaExecutorPort } from "../../creation/media-executors/contracts.js";
import { creationDigest, creationInteger, creationText, creationUuid } from "../../creation/validation.js";

export interface CliMediaOptions {
  service?: CreationMediaExecutorPort;
  administrator(owner: string): boolean;
}

/** CLI management uses the same private worker and owner binding as the browser settings. */
export async function executeCliMedia(
  options: CliMediaOptions | undefined,
  owner: string,
  command: CliCommandId,
  args: Record<string, unknown>,
  signal: AbortSignal,
) {
  const service = options?.service;
  if (command.startsWith("media.cli.") && !options?.administrator(owner)) throw new CliError("forbidden", 403);
  try {
    if (command === "media.list")
      return {
        configured: !!service,
        ...((await service?.list(owner)) ?? { presets: [], executors: [], credentials: [] }),
      };
    if (command === "media.cli.list") return { configured: !!service, packages: (await service?.cliCatalog()) ?? [] };
    if (!service) throw new CliError("notReady", 503);
    if (command === "media.connect") return await service.save(owner, args);
    if (command === "media.credentials.save") return await service.saveCredential(owner, args);
    const revision = creationInteger(args.revision);
    if (command === "media.credentials.remove") {
      await service.removeCredential(owner, creationUuid(args.id), revision);
      return { removed: true };
    }
    if (command === "media.remove") {
      await service.remove(owner, creationUuid(args.id), revision);
      return { removed: true };
    }
    const id = creationText(args.id, 64);
    if (command === "media.cli.instructions") return await service.cliInstructions(id, revision);
    if (command === "media.cli.register") {
      await service.registerCli(id, revision, creationDigest(args.fingerprint), signal);
      return { registered: true };
    }
    throw new CliError("notFound", 404);
  } catch (error) {
    const code = error instanceof MediaExecutorError || error instanceof CreationError ? error.code : undefined;
    if (code === "invalidInput") throw new CliError("invalidInput", 400);
    if (code === "notFound") throw new CliError("notFound", 404);
    if (code === "conflict") throw new CliError("conflict", 409);
    if (code === "authentication") throw new CliError("configuration", 422);
    if (code === "rateLimited") throw new CliError("limit", 429);
    throw error;
  }
}
