import type { Translate } from "../../shared/i18n/messages.js";
import { escapeHtml as e } from "../../shared/html.js";
import type { SearchCatalog } from "./api.js";
import { searchField, searchInput } from "./form-fields.js";

export function searchConfigurationHtml(c: SearchCatalog, t: Translate) {
  const field = (key: Parameters<typeof searchField>[1], control: string) => searchField(t, key, control),
    connections = (kind: string) => c.connections.filter((p) => p.kind === kind),
    options = (items: { id: string }[]) => items.map((p) => `<option value="${e(p.id)}">${e(p.id)}</option>`).join("");
  return `<section class="search-settings-section">
    <div class="resource-heading resource-section-heading"><h2>${e(t("search.sources"))}</h2><button type="button" class="wb-button" data-source-new>${e(t("search.addSource"))}</button></div>
    <p>${e(t("search.oneSourceHint"))}</p>
    <div class="search-source-grid">${c.sources.map((s) => `<article class="publish-object"><header><h2 data-i18n-ignore>${e(s.name)}</h2>${s.id === c.binding.source ? `<span class="resource-badge">${e(t("search.liveSource"))}</span>` : ""}</header><p>${e(s.kind === "local" ? t("search.builtin") : "Elasticsearch")} · <span data-i18n-ignore>${e(s.id)}</span></p><p>${e(t(s.enabled ? "search.enabled" : "search.disabled"))}${s.knowledge ? ` · ${e(t("search.knowledgeProfile"))}: <span data-i18n-ignore>${e(s.knowledge)}</span>` : ""}</p><div class="resource-actions"><button type="button" class="wb-button" data-source-edit="${e(s.id)}">${e(t("search.editSource"))}</button><button type="button" class="wb-button" data-source-health="${e(s.id)}">${e(t("search.checkConnection"))}</button><button type="button" class="wb-button" data-source-activate="${e(s.id)}" ${!s.enabled || s.id === c.binding.source ? "disabled" : ""}>${e(t("search.useForSearch"))}</button></div></article>`).join("")}</div>
    <form class="search-form" data-source-form hidden><h3 data-source-form-title>${e(t("search.addSource"))}</h3><div class="search-field-grid">
      ${field("search.identifier", searchInput("id", "text", true))}${field("search.name", searchInput("name", "text", true))}
      ${field("search.engine", `<select name="pf-search-kind" class="wb-select"><option value="local">${e(t("search.builtin"))}</option><option value="elasticsearch">Elasticsearch</option></select>`)}
      ${field("search.connectionProfile", `<select name="pf-search-connection" class="wb-select"><option value="">${e(t("search.none"))}</option>${options(connections("elasticsearch"))}</select>`)}
      ${field("search.knowledgeProfile", `<select name="pf-search-knowledge" class="wb-select"><option value="">${e(t("search.none"))}</option>${options(c.knowledge)}</select>`)}
    </div><p>${e(t("search.sourceKnowledgeHint"))}</p><label class="search-checkbox wb-choice"><input name="pf-search-enabled" type="checkbox" checked><span>${e(t("search.enabledForTesting"))}</span></label><div class="resource-actions"><button type="submit" class="wb-button">${e(t("common.save"))}</button><button type="button" class="wb-button" data-source-cancel>${e(t("common.cancel"))}</button></div></form>
    <details class="search-connections"><summary>${e(t("search.connectionProfiles"))}</summary><p>${e(t("search.profileHint"))}</p>
      <div class="search-profile-list">${c.connections.map((p) => `<article><strong data-i18n-ignore>${e(p.id)}</strong><span data-i18n-ignore>${e(p.kind)} · ${e(p.url)}</span>${p.model ? `<span data-i18n-ignore>${e(p.model)} · ${e(String(p.dimensions))}</span>` : ""}<small>${e(t(p.managed ? "search.webManaged" : "search.installManaged"))}</small></article>`).join("")}</div>
      <form class="search-form" data-connection-form><h3>${e(t("search.addConnection"))}</h3><div class="search-field-grid">
        ${field("search.identifier", searchInput("id", "text", true))}
        ${field("search.connectionType", `<select name="pf-search-kind" class="wb-select"><option value="elasticsearch">Elasticsearch</option><option value="milvus">Milvus</option><option value="ollama">Ollama</option><option value="openai">${e(t("search.openaiCompatible"))}</option></select>`)}
        ${field("search.endpoint", searchInput("url", "url", true))}
        ${field("search.authentication", `<select name="pf-search-authentication" class="wb-select"><option value="none">${e(t("search.noAuthentication"))}</option><option value="password">${e(t("search.usernamePassword"))}</option><option value="apiKey">API key</option></select>`)}
        <div data-connection-username hidden>${field("search.username", searchInput("username"))}</div>
        <div data-connection-secret hidden>${field("search.secret", searchInput("secret", "password"))}</div>
        <div data-connection-model hidden>${field("search.embeddingModel", searchInput("model"))}</div>
        <div data-connection-dimensions hidden>${field("search.embeddingDimensions", '<input name="pf-search-dimensions" type="number" min="1" max="65536" step="1">')}</div>
        ${field("search.caCertificate", '<input name="pf-search-ca" type="file" accept=".pem,.crt,.cer">')}
      </div><p data-connection-hint>${e(t("search.endpointHint"))}</p><div class="resource-actions"><button type="submit" class="wb-button">${e(t("search.saveConnection"))}</button></div></form>
      <section class="search-profile-section"><h3>${e(t("search.knowledgeProfiles"))}</h3><p>${e(t("search.knowledgeProfilesHint"))}</p><div class="search-profile-list">${c.knowledge.map((p) => `<article><strong data-i18n-ignore>${e(p.id)}</strong><span data-i18n-ignore>${e(p.vectors)} + ${e(p.embeddings)}</span></article>`).join("")}</div>
        <form class="search-form" data-knowledge-profile-form><div class="search-field-grid">
          ${field("search.identifier", searchInput("id", "text", true))}
          ${field("search.vectorConnection", `<select name="pf-search-vectors" class="wb-select" required><option value="">${e(t("search.none"))}</option>${options(connections("milvus"))}</select>`)}
          ${field("search.embeddingConnection", `<select name="pf-search-embeddings" class="wb-select" required><option value="">${e(t("search.none"))}</option>${options(c.connections.filter((p) => ["ollama", "openai"].includes(p.kind)))}</select>`)}
        </div><div class="resource-actions"><button type="submit" class="wb-button">${e(t("search.saveKnowledgeProfile"))}</button></div></form>
      </section>
    </details>
  </section>`;
}
