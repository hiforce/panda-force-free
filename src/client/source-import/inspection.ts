import type { Translate } from "../../shared/i18n/messages.js";
import type { SourceSnapshotDescriptor } from "../../shared/packages/sources/snapshot.js";
import type { TemplateSourceInspection } from "../../shared/templates/sources/contracts.js";
import { setMessageHtml, errorText } from "../i18n.js";
import { sourceInspection, sourceFileRows } from "./views.js";
import { createCandidateImports } from "./candidate-imports.js";

import { PluginApiError } from "../plugins/api.js";

/** File pagination appends into its own list and preserves the surrounding dialog and inputs. */
export function createSourceInspection(t: Translate, host: HTMLElement, changed: () => void) {
  let source: SourceSnapshotDescriptor | null = null,
    shown = 0,
    reference: { id: string; sha256: string } | null = null,
    candidates: TemplateSourceInspection["candidates"] = [],
    importable: TemplateSourceInspection["importableKinds"] = [],
    imports: ReturnType<typeof createCandidateImports> | null = null;
  function more() {
    if (!source) return;
    const rows = document.createElement("ul"),
      end = Math.min(shown + 100, source.files.length);
    setMessageHtml(rows, sourceFileRows(source.files.slice(shown, end)));
    host.querySelector(".source-file-list")!.append(...rows.childNodes);
    shown = end;
    host.querySelector("[data-source-file-count]")!.textContent = t("sources.showingFiles", {
      shown,
      total: source.files.length,
    });
    host.querySelector<HTMLButtonElement>("[data-source-more-files]")!.hidden = shown >= source.files.length;
  }
  host.onclick = (event) => {
    if (event.target instanceof Element && event.target.closest("[data-source-more-files]")) more();
    const button =
      event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-source-choose]") : null;
    if (!button || !reference || !imports) return;
    const candidate = candidates[Number(button.dataset.sourceChoose)];
    if (!candidate || !importable.includes(candidate.kind)) return;
    const active = imports;
    void Promise.resolve(active.choose(reference, candidate)).catch((error) => {
      if (active !== imports) return;
      const node = document.createElement("p");
      node.dataset.error = "true";
      node.textContent = errorText(
        error instanceof PluginApiError ? error.payload : null,
        t,
        "sources.stageUnavailable",
      );
      host.querySelector(".source-candidates")?.append(node);
    });
  };
  return {
    show(value: TemplateSourceInspection, id: string) {
      imports?.reset();
      source = value.source;
      candidates = value.candidates;
      importable = value.importableKinds;
      reference = { id, sha256: value.sourceDigest };
      shown = 0;
      setMessageHtml(host, sourceInspection(t, value));
      host.hidden = false;
      imports = createCandidateImports(t, host, changed);
      more();
    },
    loading() {
      imports?.reset();
      imports = null;
      candidates = [];
      importable = [];
      reference = null;
      source = null;
      host.textContent = t("sources.working");
      host.hidden = false;
    },
    clear() {
      imports?.reset();
      imports = null;
      candidates = [];
      importable = [];
      reference = null;
      source = null;
      shown = 0;
      host.replaceChildren();
      host.hidden = true;
    },
  };
}
