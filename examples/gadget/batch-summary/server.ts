import manifest from "./manifest.json";
import type { GadgetModule, GadgetManifest } from "../../../src/gadget/sdk/server.js";
export interface BatchProvider {
  canRead(owner: string, batch: string): Promise<boolean>;
  read(owner: string, batch: string, signal: AbortSignal): Promise<{ processed: number; total: number }>;
}
/** The deployment's integration module supplies its authenticated business adapter and bundled UI. */
export function createBatchSummary(provider: BatchProvider, frontend: string): GadgetModule {
  return {
    manifest: manifest as GadgetManifest,
    frontend,
    services: {
      summary: {
        authorize: (context) => provider.canRead(context.owner, String(context.config.batch)),
        handle: (context) => provider.read(context.owner, String(context.config.batch), context.signal),
      },
    },
    actions: {
      open: {
        authorize: (context) => provider.canRead(context.owner, String(context.config.batch)),
        handle: () => ({ navigate: "/bots" }),
      },
    },
  };
}
