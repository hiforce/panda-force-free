import { unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readPrivateDatabaseFile } from "../../database/config.js";
import { isStoredAdministrator, saveStoredAdministrator } from "../administrator-store.js";
import type { AuthState } from "../state.js";
import type { LocalUserRepository } from "./contracts.js";
import type { LocalAccountMail } from "./mail.js";
import { memberEmail } from "./records.js";
import { isRecord } from "../../../shared/records.js";

/** Explicit private migration input, consumed once. Existing credentials and model authentication are never overwritten. */
export async function bootstrapLocalAccounts(
  path: string,
  auth: AuthState,
  repository: LocalUserRepository,
  mail: LocalAccountMail,
) {
  const bytes = await readPrivateDatabaseFile(path, 65536),
    digest = createHash("sha256").update(bytes).digest("hex");
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } finally {
    bytes.fill(0);
  }
  if (!isRecord(value) || value.schema !== 1 || !isStoredAdministrator(value.administrator) || !isRecord(value.smtp))
    throw Error("Invalid local account migration input");
  const administrator = value.administrator,
    email = memberEmail(value.email);
  if (
    auth.administrator &&
    (auth.administrator.username !== administrator.username ||
      auth.administrator.createdAt !== administrator.createdAt ||
      auth.administrator.ownerId !== administrator.ownerId)
  )
    throw Error("Local administrator migration conflicts with an existing installation");
  if (!auth.administrator) {
    if (auth.saveAdministrator) await auth.saveAdministrator(administrator);
    else saveStoredAdministrator(auth.administratorPath, administrator);
    auth.adoptAdministrator(administrator);
  }
  const current = await repository.settings();
  if (current.bootstrapDigest !== digest) {
    await mail.save({ ...value.smtp, revision: current.revision }, AbortSignal.timeout(30000));
    const settings = await repository.settings();
    await repository.saveSettings(
      {
        ...settings,
        revision: settings.revision + 1,
        administratorEmail: { email, verifiedAt: Date.now() },
        bootstrapDigest: digest,
      },
      settings.revision,
    );
  }
  await unlink(path);
}
