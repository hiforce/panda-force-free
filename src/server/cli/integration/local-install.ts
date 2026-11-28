import { rm } from "node:fs/promises";
import { join } from "node:path";
import { readPrivateJson, writePrivateJson } from "../../../cli/files.js";
import { CliProfiles } from "../../../cli/profiles.js";
import { CliError, cliObject, cliRegistration } from "../../../shared/cli/contracts.js";
import type { CliCredentials } from "../auth/service.js";

/** Provision the installation operator's container CLI once, using its private application volume. */
export async function installLocalCli(
  credentials: CliCredentials,
  home: string,
  server: string,
  owner: string,
  authorize: (project: string) => Promise<void>,
) {
  const profiles = new CliProfiles(home);
  const journal = join(home, ".installation-pending.json");
  const saved = await profiles.savedRegistration("default");
  const staged = await readPrivateJson(journal, true).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (staged === undefined && saved) return;
  if (staged !== undefined) {
    const pending = cliObject(staged, ["registration", "apiKey"]);
    const registration = cliRegistration(pending.registration);
    const apiKey = pending.apiKey;
    if (registration.server !== server || typeof apiKey !== "string") throw new CliError("invalidInput");
    if (saved) {
      const existing = await profiles.credentials("default", "").catch((error: unknown) => {
        if (error instanceof CliError && error.code === "authenticationRequired") return undefined;
        throw error;
      });
      if (saved.clientId !== registration.clientId || existing) {
        await rm(journal);
        return;
      }
    }
    const grant = await credentials.authenticate(registration.clientId, apiKey).catch((error: unknown) => {
      if (!(error instanceof CliError && error.code === "authenticationRequired") || saved) throw error;
      return undefined;
    });
    if (grant) {
      if (grant.owner !== owner) throw new CliError("forbidden", 403);
      await profiles.register("default", registration);
      await profiles.login("default", apiKey);
      await rm(journal);
      return;
    }
  }
  const { registration, apiKey } = await credentials.issue(
    owner,
    server,
    {
      name: "Local Panda CLI",
      kind: "cli",
      projects: ["personal"],
      capabilities: ["media:read"],
      expiresInDays: 365,
    },
    authorize,
    async (registration, apiKey) => writePrivateJson(journal, { registration, apiKey }),
  );
  await profiles.register("default", registration);
  await profiles.login("default", apiKey);
  await rm(journal);
}
