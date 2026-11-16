export interface DatabaseRecovery {
  id: string;
  statusToken: string;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const key = () =>
  "panda-database-operation:" +
  ((globalThis as typeof globalThis & { __pandaForceIdentityKey?: string }).__pandaForceIdentityKey ?? "local");
/** Connection fields and passwords never enter browser storage. This capability addresses one durable operation. */
export function readDatabaseRecovery(): DatabaseRecovery | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key()) ?? "null");
    return value &&
      uuid.test(value.id) &&
      /^[a-zA-Z0-9_-]{43}$/.test(value.statusToken) &&
      Object.keys(value).length === 2
      ? value
      : null;
  } catch {
    return null;
  }
}
export function rememberDatabaseRecovery(): DatabaseRecovery {
  const bytes = crypto.getRandomValues(new Uint8Array(32)),
    statusToken = btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
  const recovery = { id: crypto.randomUUID(), statusToken };
  sessionStorage.setItem(key(), JSON.stringify(recovery));
  if (sessionStorage.getItem(key()) !== JSON.stringify(recovery)) throw Error("recoveryUnavailable");
  return recovery;
}
export function clearDatabaseRecovery() {
  try {
    sessionStorage.removeItem(key());
  } catch {}
}

/** Maintenance has no authenticated app bootstrap; find only the capability for the public operation id. */
export function findDatabaseRecovery(id: string): DatabaseRecovery | null {
  if (!uuid.test(id)) return null;
  try {
    for (const name of Object.keys(sessionStorage)) {
      if (!name.startsWith("panda-database-operation:")) continue;
      try {
        const value = JSON.parse(sessionStorage.getItem(name) ?? "null");
        if (value?.id === id && /^[a-zA-Z0-9_-]{43}$/.test(value.statusToken) && Object.keys(value).length === 2)
          return value;
      } catch {}
    }
  } catch {}
  return null;
}
