import type { GadgetManifest, GadgetLayout, GadgetConfig } from "../../shared/gadget/contracts.js";
export class GadgetApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}
/** Supply an authenticated fetch transport for server integration; browsers use same-origin session cookies. */
export class GadgetClient {
  constructor(
    private base = "",
    private transport: typeof fetch = fetch,
  ) {}
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.transport(this.base + "/api/gadgets/" + path, {
      ...init,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...init.headers },
    });
    const value = await response.json();
    if (!response.ok) throw new GadgetApiError(value?.error?.code || "unavailable", response.status);
    return value as T;
  }
  catalog(signal?: AbortSignal) {
    return this.request<{ apiVersion: 1; gadgets: Array<GadgetManifest & { frontend: boolean }> }>("catalog", {
      signal,
    });
  }
  layout(signal?: AbortSignal) {
    return this.request<GadgetLayout>("layout", { signal });
  }
  save(layout: GadgetLayout, operationId: string, signal?: AbortSignal) {
    return this.request<GadgetLayout>("layout", {
      method: "PUT",
      signal,
      headers: { "If-Match": `"${layout.revision}"` },
      body: JSON.stringify({ layout, operationId }),
    });
  }
  invoke(
    gadget: string,
    instanceId: string,
    config: GadgetConfig,
    name: string,
    input: unknown = null,
    signal?: AbortSignal,
    action = false,
  ) {
    return this.request<{ value: unknown }>(action ? "actions" : "data", {
      method: "POST",
      signal,
      body: JSON.stringify({ gadget, instanceId, config, name, input }),
    }).then((x) => x.value);
  }
  async frontend(id: string, signal: AbortSignal) {
    const response = await this.transport(this.base + "/api/gadgets/frontend/" + encodeURIComponent(id), {
      credentials: "same-origin",
      signal,
    });
    if (!response.ok) throw new GadgetApiError("unavailable", response.status);
    const value = await response.text();
    if (value.length > 256 * 1024) throw new GadgetApiError("unavailable", 503);
    return value;
  }
}
