import { request } from "../http-client.js";
import type { ConnectionInput, PublicationConnection, PublicationRoot } from "../../shared/connections/contracts.js";
import type { SitePublication, SitePublicationRequest } from "../../shared/delivery/contracts.js";

export class DeliveryApiError extends Error {
  constructor(readonly payload: unknown) {
    super("Publication request failed");
  }
}
async function json<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await request(path, {
    method,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const payload: unknown = await response.json();
  if (!response.ok) throw new DeliveryApiError(payload);
  return payload as T;
}
const query = (name: string, value: string) => "?" + new URLSearchParams({ [name]: value });
export const deliveryApi = {
  roots: () => json<{ roots: PublicationRoot[] }>("/api/publication-connections/roots"),
  connections: (project: string) =>
    json<{ connections: PublicationConnection[] }>("/api/publication-connections" + query("project", project)),
  connection: (id: string) =>
    json<{ connection: PublicationConnection }>("/api/publication-connections/detail" + query("id", id)),
  createConnection: (input: ConnectionInput) =>
    json<{ connection: PublicationConnection }>("/api/publication-connections", "POST", input),
  updateConnection: (id: string, input: Pick<PublicationConnection, "name" | "publicUrl" | "version" | "enabled">) =>
    json<{ connection: PublicationConnection }>("/api/publication-connections/detail" + query("id", id), "PUT", input),
  testConnection: (id: string, version: number) =>
    json<{ servedPath: string; connection: PublicationConnection }>(
      "/api/publication-connections/test" + query("id", id),
      "POST",
      { version },
    ),
  replaceHostKey: (id: string, version: number, hostKey: string) =>
    json<{ connection: PublicationConnection }>("/api/publication-connections/trust" + query("id", id), "PUT", {
      version,
      hostKey,
    }),
  saveCredential: (id: string, version: number, credential: Record<string, string>) =>
    json<{ connection: PublicationConnection }>("/api/publication-connections/credentials" + query("id", id), "PUT", {
      version,
      credential,
    }),
  list: (space: string, projectId?: string) =>
    json<{ publications: SitePublication[] }>(
      "/api/site-publications?" +
        new URLSearchParams({ space, ...(projectId === undefined ? {} : { project: projectId }) }),
    ),
  prepare: (input: SitePublicationRequest) =>
    json<{ publication: SitePublication }>("/api/site-publications", "POST", input),
  publish: (id: string, fingerprint: string) =>
    json<{ publication: SitePublication }>("/api/site-publications/publish", "POST", { id, fingerprint }),
  cancel: (id: string) => json<{ publication: SitePublication }>("/api/site-publications/cancel", "POST", { id }),
  reconcile: (id: string) => json<{ publication: SitePublication }>("/api/site-publications/reconcile", "POST", { id }),
  recover: (id: string, fingerprint: string) =>
    json<{ publication: SitePublication }>("/api/site-publications/recover", "POST", { id, fingerprint }),
};
