import type { Translate } from "../../shared/i18n/messages.js";
import type { SearchSourceDefinition } from "../../shared/search/contracts.js";
import { SearchRequestError, type SearchCatalog } from "./api.js";
import { searchChecked as checked, searchValue as value } from "./form-fields.js";

export interface SearchConfigurationActions {
  api<T>(path: string, method: string, body: unknown): Promise<T>;
  run(work: () => Promise<void>): Promise<void>;
  reload(): Promise<void>;
  notice(message: string): void;
}

/** Connection credentials never enter rendered catalog metadata or source definitions. */
export function bindSearchConfiguration(
  host: HTMLElement,
  catalog: SearchCatalog,
  t: Translate,
  actions: SearchConfigurationActions,
) {
  const get = <T extends HTMLElement>(q: string) => host.querySelector<T>(q)!,
    sourceForm = get<HTMLFormElement>("[data-source-form]"),
    connectionForm = get<HTMLFormElement>("[data-connection-form]"),
    control = (form: HTMLFormElement, name: string) => form.elements.namedItem("pf-search-" + name) as HTMLInputElement;
  let editing: SearchSourceDefinition | null = null;
  const submit = (selector: string, work: (form: HTMLFormElement) => Promise<void>) => {
    get<HTMLFormElement>(selector).onsubmit = (event) => {
      event.preventDefault();
      void actions.run(() => work(event.currentTarget as HTMLFormElement));
    };
  };
  const syncEngine = () => {
    const connection = control(sourceForm, "connection");
    connection.disabled = value(sourceForm, "kind") === "local";
    connection.required = !connection.disabled;
  };
  control(sourceForm, "kind").onchange = syncEngine;
  const openSource = (id?: string) => {
    editing = catalog.sources.find((s) => s.id === id) ?? null;
    sourceForm.reset();
    for (const name of ["id", "name", "kind", "connection", "knowledge"] as const)
      control(sourceForm, name).value = String(editing?.[name] ?? (name === "kind" ? "local" : ""));
    control(sourceForm, "id").readOnly = !!editing;
    control(sourceForm, "enabled").checked = editing?.enabled ?? true;
    get("[data-source-form-title]").textContent = t(editing ? "search.editSource" : "search.addSource");
    sourceForm.hidden = false;
    syncEngine();
    sourceForm.scrollIntoView({ block: "nearest" });
    control(sourceForm, "name").focus();
  };
  get<HTMLButtonElement>("[data-source-new]").onclick = () => openSource();
  get<HTMLButtonElement>("[data-source-cancel]").onclick = () => {
    sourceForm.hidden = true;
  };
  for (const button of host.querySelectorAll<HTMLButtonElement>("[data-source-edit]"))
    button.onclick = () => openSource(button.dataset.sourceEdit);
  for (const button of host.querySelectorAll<HTMLButtonElement>("[data-source-health]"))
    button.onclick = () =>
      void actions.run(async () => {
        const result = await actions.api<{ text: boolean; knowledge: boolean | null }>("/health", "POST", {
          source: button.dataset.sourceHealth,
        });
        if (!result.text || result.knowledge === false) throw new SearchRequestError("unavailable");
        actions.notice(t("search.connectionReady"));
      });
  for (const button of host.querySelectorAll<HTMLButtonElement>("[data-source-activate]"))
    button.onclick = () =>
      void actions.run(async () => {
        const source = catalog.sources.find((s) => s.id === button.dataset.sourceActivate)!;
        await actions.api("/activate", "POST", {
          source: source.id,
          sourceRevision: source.revision,
          revision: catalog.binding.revision,
        });
        await actions.reload();
      });
  submit("[data-source-form]", async (form) => {
    await actions.api("/sources", "PUT", {
      revision: editing?.revision ?? 0,
      source: {
        id: value(form, "id"),
        name: value(form, "name"),
        kind: value(form, "kind"),
        connection: value(form, "kind") === "local" ? null : value(form, "connection"),
        knowledge: value(form, "knowledge") || null,
        enabled: checked(form, "enabled"),
      },
    });
    await actions.reload();
  });
  const syncConnection = () => {
    const kind = value(connectionForm, "kind"),
      embedding = ["ollama", "openai"].includes(kind),
      auth = control(connectionForm, "authentication") as unknown as HTMLSelectElement;
    auth.querySelector<HTMLOptionElement>('option[value="password"]')!.disabled = embedding;
    if (embedding && auth.value === "password") auth.value = "none";
    for (const [name, visible] of [
      ["username", auth.value === "password"],
      ["secret", auth.value !== "none"],
      ["model", embedding],
      ["dimensions", embedding],
    ] as const) {
      get("[data-connection-" + name + "]").hidden = !visible;
      control(connectionForm, name).disabled = !visible;
      control(connectionForm, name).required = visible;
    }
    get("[data-connection-hint]").textContent = t(embedding ? "search.embeddingEndpointHint" : "search.endpointHint");
    control(connectionForm, "secret").value = "";
  };
  control(connectionForm, "kind").onchange = syncConnection;
  control(connectionForm, "authentication").onchange = syncConnection;
  syncConnection();
  submit("[data-connection-form]", async (form) => {
    const authentication = value(form, "authentication"),
      kind = value(form, "kind"),
      file = control(form, "ca").files?.[0],
      secret = value(form, "secret");
    control(form, "secret").value = "";
    if (file && file.size > 16384) throw new SearchRequestError("limit");
    await actions.api("/connections", "POST", {
      id: value(form, "id"),
      kind,
      url: value(form, "url"),
      ...(["ollama", "openai"].includes(kind)
        ? { model: value(form, "model"), dimensions: Number(value(form, "dimensions")) }
        : {}),
      ...(authentication === "password"
        ? { username: value(form, "username"), password: secret }
        : authentication === "apiKey"
          ? { apiKey: secret }
          : {}),
      ...(file ? { ca: await file.text() } : {}),
    });
    form.reset();
    await actions.reload();
  });
  submit("[data-knowledge-profile-form]", async (form) => {
    await actions.api("/knowledge-profiles", "POST", {
      id: value(form, "id"),
      vectors: value(form, "vectors"),
      embeddings: value(form, "embeddings"),
    });
    await actions.reload();
  });
}
