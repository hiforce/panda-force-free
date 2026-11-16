import type { DatabaseConnectionInput } from "../../shared/database/contracts.js";
export interface DatabaseForm {
  hostname: string;
  port: string;
  database: string;
  username: string;
  password: string;
  tls: string;
  caFile: string;
  max: string;
  connectionTimeout: string;
  idleTimeout: string;
  advanced: boolean;
}
export const emptyDatabaseForm = (): DatabaseForm => ({
  hostname: "localhost",
  port: "3306",
  database: "",
  username: "",
  password: "",
  tls: "verify",
  caFile: "",
  max: "",
  connectionTimeout: "",
  idleTimeout: "",
  advanced: false,
});
export function readDatabaseForm(root: HTMLElement, prior: DatabaseForm): DatabaseForm {
  const next = { ...prior };
  for (const key of Object.keys(next)) {
    if (key === "advanced") continue;
    const field = root.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-database-field="${key}"]`);
    if (field) (next as unknown as Record<string, unknown>)[key] = field.value;
  }
  const details = root.querySelector<HTMLDetailsElement>("[data-database-advanced]");
  if (details) next.advanced = details.open;
  return next;
}
export function fillDatabaseForm(root: HTMLElement, value: DatabaseForm) {
  for (const [key, text] of Object.entries(value)) {
    if (key === "advanced") continue;
    const field = root.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-database-field="${key}"]`);
    if (field) field.value = String(text);
  }
  const details = root.querySelector<HTMLDetailsElement>("[data-database-advanced]");
  if (details) details.open = value.advanced;
}
export function databaseConnectionInput(value: DatabaseForm): DatabaseConnectionInput {
  return {
    hostname: value.hostname.trim(),
    port: Number(value.port),
    database: value.database.trim(),
    username: value.username.trim(),
    password: value.password,
    tls:
      value.tls === "disabled"
        ? { mode: "disabled" }
        : { mode: "verify", ...(value.caFile.trim() ? { caFile: value.caFile.trim() } : {}) },
    ...(value.max ? { max: Number(value.max) } : {}),
    ...(value.connectionTimeout ? { connectionTimeout: Number(value.connectionTimeout) } : {}),
    ...(value.idleTimeout ? { idleTimeout: Number(value.idleTimeout) } : {}),
  };
}
