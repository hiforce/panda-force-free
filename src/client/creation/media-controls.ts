import type { CreationRequestedOutput } from "../../shared/creation/contracts.js";
import type { CreationMediaChoice } from "../../shared/creation/media-executors.js";
import type { MessageId, Translate } from "../../shared/i18n/messages.js";
import { harnessApi } from "../harness/api.js";
import { localizeText, messageHtml, setMessageHtml } from "../i18n.js";
import { executorEndpoint } from "../settings-pages/executor-catalog.js";
import type { ExecutorCatalog } from "../settings-pages/executor-catalog.js";
import type { ExecutorBrand } from "../settings-pages/executor-brands.js";
import { createExecutorPicker } from "../settings-pages/executor-picker.js";
import { createExecutorDialog } from "../settings-pages/executor-dialog.js";

export const creationOutputLabels = {
  auto: "creation.mediaAutomatic",
  document: "creative.document",
  image: "creative.image",
  slides: "creative.slides",
  video: "creative.video",
  web: "creative.web",
} as const satisfies Record<CreationRequestedOutput, MessageId>;

export function creationOutputPreference(value: unknown): CreationRequestedOutput | undefined {
  return typeof value === "string" && Object.hasOwn(creationOutputLabels, value)
    ? (value as CreationRequestedOutput)
    : undefined;
}

type Selection = {
  output?: CreationRequestedOutput;
  media?: CreationMediaChoice;
  nativeImage: "available" | "unsupported" | "unverified";
  disabled: boolean;
};

export class CreationMediaControls {
  readonly root = document.createElement("div");
  private readonly sourcePicker: ReturnType<typeof createExecutorPicker>;
  private readonly editor: ReturnType<typeof createExecutorDialog>;
  private readonly api: ReturnType<typeof harnessApi>;
  private catalog?: ExecutorCatalog;
  private loading?: Promise<void>;
  private selection: Selection = { nativeImage: "unsupported", disabled: false };
  private loadFailed = false;

  constructor(
    private readonly t: Translate,
    private readonly change: (output: CreationRequestedOutput, media: CreationMediaChoice | undefined) => void,
  ) {
    this.api = harnessApi(t);
    this.editor = createExecutorDialog(t, async () => {
      await this.load(true);
      return this.catalog;
    });
    this.root.className = "creation-media-controls wb-form";
    setMessageHtml(
      this.root,
      `
      <label class="wb-field"><span>${messageHtml("creation.mediaOutput", {}, t)}</span><select data-creation-output></select></label>
      <div class="wb-field" data-media-executor-field hidden><span data-media-executor-label></span><select data-media-executor></select></div>
      <label class="wb-field" data-media-model-field hidden><span>${messageHtml("creation.mediaModel", {}, t)}</span><select data-media-model></select></label>
      <button class="wb-button" type="button" data-media-add hidden>${messageHtml("creation.mediaAddExecutor", {}, t)}</button>
      <p class="session-caption" role="status" data-media-message hidden></p>
    `,
    );
    const output = this.root.querySelector<HTMLSelectElement>("[data-creation-output]")!;
    for (const [value, label] of Object.entries(creationOutputLabels)) output.append(this.option(value, label));
    output.onchange = () => {
      const selected = creationOutputPreference(output.value);
      if (!selected) return;
      const kind = this.kind(selected);
      this.change(selected, this.selection.media?.kind === kind ? this.selection.media : undefined);
      if (kind) void this.load(true);
    };
    const source = this.root.querySelector<HTMLSelectElement>("[data-media-executor]")!;
    this.sourcePicker = createExecutorPicker(source);
    source.onchange = () => {
      const value = source.value,
        kind = this.kind();
      if (!kind) return;
      this.change(
        this.selection.output ?? "auto",
        value === "harness"
          ? { kind, source: "harness" }
          : value
            ? { kind, source: "executor", executorId: value }
            : undefined,
      );
    };
    this.root.querySelector<HTMLSelectElement>("[data-media-model]")!.onchange = (event) => {
      const media = this.selection.media;
      if (media?.source === "executor")
        this.change(this.selection.output ?? "auto", {
          ...media,
          model: (event.currentTarget as HTMLSelectElement).value,
        });
    };
    this.root.querySelector<HTMLButtonElement>("[data-media-add]")!.onclick = (event) =>
      void this.manage(event.currentTarget as HTMLElement);
  }

  private kind(output = this.selection.output) {
    return output === "image" || output === "slides" ? "image" : output === "video" ? "video" : undefined;
  }

  private option(value: string, label: MessageId, raw?: string) {
    const option = document.createElement("option");
    option.value = value;
    if (raw === undefined) localizeText(option, label, {}, this.t);
    else option.textContent = raw;
    return option;
  }

  private async load(refresh = false) {
    if (this.loading) return this.loading;
    if (this.catalog && !refresh) return;
    const pending = this.api<ExecutorCatalog>(executorEndpoint)
      .then(
        (catalog) => {
          this.catalog = catalog;
          this.loadFailed = false;
        },
        () => {
          this.loadFailed = true;
        },
      )
      .finally(() => {
        this.loading = undefined;
        this.render();
      });
    this.loading = pending;
    return pending;
  }

  show(selection: Selection) {
    this.selection = selection;
    if (this.kind()) void this.load();
    this.render();
  }

  private render() {
    const selected = this.selection.media,
      kind = this.kind(),
      executors = this.catalog?.executors.filter((item) => item.kind === kind && !item.credentialUnavailable) ?? [],
      native = kind === "image" && this.selection.nativeImage === "available",
      field = this.root.querySelector<HTMLElement>("[data-media-executor-field]")!,
      label = this.root.querySelector<HTMLElement>("[data-media-executor-label]")!,
      source = this.root.querySelector<HTMLSelectElement>("[data-media-executor]")!,
      modelField = this.root.querySelector<HTMLElement>("[data-media-model-field]")!,
      model = this.root.querySelector<HTMLSelectElement>("[data-media-model]")!,
      add = this.root.querySelector<HTMLButtonElement>("[data-media-add]")!,
      message = this.root.querySelector<HTMLElement>("[data-media-message]")!,
      output = this.root.querySelector<HTMLSelectElement>("[data-creation-output]")!;
    output.value = this.selection.output ?? "auto";
    output.disabled = this.selection.disabled;
    field.hidden = !kind;
    if (!kind) this.sourcePicker.close();
    add.hidden = !kind || this.catalog?.configured === false;
    add.disabled = source.disabled = this.selection.disabled;
    model.disabled = this.selection.disabled;
    localizeText(label, kind === "video" ? "creation.mediaVideoExecutor" : "creation.mediaImageExecutor", {}, this.t);
    source.replaceChildren(
      this.option("", kind === "video" ? "creation.mediaVideoComposition" : "creation.mediaSelectExecutor"),
    );
    if (native) source.append(this.option("harness", "creation.mediaNativeImage"));
    executors.forEach((item) => source.append(this.option(item.id, "creation.mediaSelectExecutor", item.name)));
    const value = selected?.source === "harness" ? "harness" : (selected?.executorId ?? "");
    const absent = !!value && ![...source.options].some((option) => option.value === value);
    source.value = absent ? "" : value;
    const brands = new Map<string, ExecutorBrand>();
    if (native) brands.set("harness", "harness");
    for (const executor of executors) {
      const preset = this.catalog?.presets.find((item) => item.id === executor.preset);
      if (preset?.provider || preset?.transport === "cli") brands.set(executor.id, preset.provider ?? "cli");
    }
    this.sourcePicker.update(label.textContent ?? "", brands);
    const executor = executors.find((item) => item.id === value);
    const offered = executor ? (this.catalog?.presets.find((item) => item.id === executor.preset)?.models ?? []) : [];
    const models = executor?.model ? offered.filter((model) => model.id === executor.model) : offered;
    modelField.hidden = models.length < 2;
    model.replaceChildren(...models.map((item) => this.option(item.id, "creation.mediaModel", item.name)));
    model.value = selected?.source === "executor" ? (selected.model ?? executor?.model ?? models[0]?.id ?? "") : "";
    const messageId = !kind
      ? null
      : absent
        ? "creation.mediaUnavailable"
        : this.catalog?.configured === false && kind === "image" && !native
          ? "creation.mediaWorkerUnavailable"
          : this.loadFailed
            ? "creation.mediaLoadFailed"
            : executor?.status === "unverified"
              ? "creation.mediaUnverified"
              : kind === "image" && !selected && this.selection.nativeImage === "unverified"
                ? "creation.mediaNativeUnverified"
                : null;
    message.hidden = !messageId;
    if (messageId) localizeText(message, messageId, {}, this.t);
  }

  private async manage(trigger: HTMLElement) {
    const kind = this.kind();
    if (!kind || this.selection.disabled) return;
    if (!this.catalog) await this.load();
    if (!this.catalog || this.kind() !== kind || this.selection.disabled) return;
    this.editor.open(trigger, {
      catalog: this.catalog,
      kind,
      saved: async (saved) => {
        await this.load(true);
        if (trigger.isConnected && this.kind() === kind && !this.selection.disabled)
          this.change(this.selection.output ?? "auto", {
            kind,
            source: "executor",
            executorId: saved.id,
            ...(saved.model ? { model: saved.model } : {}),
          });
      },
    });
  }

  close() {
    this.sourcePicker.close();
    this.editor.close();
  }
}
