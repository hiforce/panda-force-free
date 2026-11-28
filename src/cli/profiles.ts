import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { readdir, rm } from "node:fs/promises";
import { CliError, cliObject, cliRegistration, type CliClientKind } from "../shared/cli/contracts.js";
import { assertPrivateDirectory, privateDirectory, readPrivateJson, writePrivateJson } from "./files.js";
export class CliProfiles {
  constructor(private readonly root = process.env.PANDA_CLI_HOME || join(homedir(), ".panda-force", "cli")) {}
  private directory(profile: string) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(profile)) throw new CliError("invalidInput");
    const requested = resolve(this.root),
      missing: string[] = [];
    const rootInfo = lstatSync(requested, { throwIfNoEntry: false });
    if (rootInfo?.isSymbolicLink()) throw new CliError("invalidInput");
    let ancestor = requested;
    while (!lstatSync(ancestor, { throwIfNoEntry: false })) {
      missing.unshift(basename(ancestor));
      ancestor = dirname(ancestor);
    }
    const root = resolve(realpathSync(ancestor), ...missing);
    let project = root;
    for (let depth = 0; depth < 256; depth++) {
      const marker = join(project, ".git"),
        info = lstatSync(marker, { throwIfNoEntry: false });
      if (
        info &&
        (!info.isDirectory() ||
          (lstatSync(join(marker, "HEAD"), { throwIfNoEntry: false }) &&
            lstatSync(join(marker, "config"), { throwIfNoEntry: false })))
      )
        throw new CliError("invalidInput");
      const parent = dirname(project);
      if (parent === project) return join(root, "profiles", profile);
      project = parent;
    }
    throw new CliError("invalidInput");
  }
  async register(profile: string, input: unknown) {
    const registration = cliRegistration(input),
      dir = this.directory(profile);
    await privateDirectory(dirname(dirname(dir)));
    await privateDirectory(dirname(dir));
    await privateDirectory(dir);
    try {
      const old = cliRegistration(await readPrivateJson(join(dir, "registration.json")));
      if (
        old.clientId !== registration.clientId ||
        old.server !== registration.server ||
        old.kind !== registration.kind
      )
        throw new CliError("conflict", 409);
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    await writePrivateJson(join(dir, "registration.json"), registration);
    return { registered: true, profile, server: registration.server, kind: registration.kind };
  }
  async registration(profile: string) {
    try {
      const registration = await this.savedRegistration(profile);
      if (registration) return registration;
    } catch {
      // Preserve the public authentication error for unavailable local credentials.
    }
    throw new CliError("authenticationRequired", 401);
  }
  async savedRegistration(profile: string) {
    const dir = this.directory(profile);
    try {
      for (const path of [dirname(dirname(dir)), dirname(dir), dir]) await assertPrivateDirectory(path);
      return cliRegistration(await readPrivateJson(join(dir, "registration.json"), true));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }
  async login(profile: string, apiKey: string) {
    const registration = await this.registration(profile);
    if (!/^pfk_[a-f0-9]{24}_[a-zA-Z0-9_-]{43}$/.test(apiKey)) throw new CliError("authenticationRequired", 401);
    await writePrivateJson(join(this.directory(profile), "credentials.json"), {
      schema: 1,
      clientId: registration.clientId,
      server: registration.server,
      apiKey,
    });
    return { saved: true, profile };
  }
  async credentials(profile: string, environmentKey = process.env.PANDA_API_KEY) {
    const registration = await this.registration(profile);
    if (environmentKey) {
      if (!/^pfk_[a-f0-9]{24}_[a-zA-Z0-9_-]{43}$/.test(environmentKey))
        throw new CliError("authenticationRequired", 401);
      return { registration, apiKey: environmentKey };
    }
    try {
      const p = cliObject(await readPrivateJson(join(this.directory(profile), "credentials.json"), true), [
        "schema",
        "clientId",
        "server",
        "apiKey",
      ]);
      if (
        p.schema !== 1 ||
        p.clientId !== registration.clientId ||
        p.server !== registration.server ||
        typeof p.apiKey !== "string" ||
        !/^pfk_[a-f0-9]{24}_[a-zA-Z0-9_-]{43}$/.test(p.apiKey)
      )
        throw new CliError("authenticationRequired", 401);
      return { registration, apiKey: p.apiKey };
    } catch {
      throw new CliError("authenticationRequired", 401);
    }
  }
  async logout(profile: string) {
    await rm(join(this.directory(profile), "credentials.json"), { force: true });
    return { removed: true, profile };
  }
  async selected() {
    try {
      const value = cliObject(
        await readPrivateJson(join(dirname(dirname(this.directory("default"))), "selection.json"), true),
        ["schema", "profile"],
      );
      if (value.schema !== 1 || typeof value.profile !== "string") throw new CliError("invalidInput");
      this.directory(value.profile);
      return value.profile;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return "default";
      throw error;
    }
  }
  async use(profile: string) {
    await this.registration(profile);
    await writePrivateJson(join(dirname(dirname(this.directory(profile))), "selection.json"), { schema: 1, profile });
    return { profile, selected: true };
  }
  async list(offset = 0) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new CliError("invalidInput");
    const directory = dirname(this.directory("default"));
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        return { profiles: [], nextOffset: null };
      throw error;
    }
    const names = entries
      .filter(
        (entry) =>
          entry.isDirectory() && !entry.isSymbolicLink() && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(entry.name),
      )
      .map((entry) => entry.name)
      .sort();
    const profiles: { name: string; server: string; kind: CliClientKind; clientId: string }[] = [];
    for (const name of names.slice(offset, offset + 100)) {
      const value = await this.registration(name);
      profiles.push({ name, server: value.server, kind: value.kind, clientId: value.clientId });
    }
    return { profiles, nextOffset: offset + 100 < names.length ? offset + 100 : null };
  }
}
