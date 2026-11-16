import type { Translate, MessageId } from "../../shared/i18n/messages.js";
import type { ConnectionInput, PublicationConnection, PublicationRoot } from "../../shared/connections/contracts.js";
import { setMessageHtml, messageHtml, errorText } from "../i18n.js";

import { deliveryApi, DeliveryApiError } from "./api.js";
import { connectionOptions } from "./views.js";
import { connectionForm } from "./connection-form.js";
import { bindCredentialForm } from "./credential-form.js";
import { bindHostTrustForm } from "./host-trust-form.js";

type EditorNotice = "saved" | "tested" | "refreshed" | "trustUpdated";
const notices: Record<EditorNotice, MessageId> = {
  saved: "connections.saved",
  tested: "connections.tested",
  refreshed: "connections.refreshed",
  trustUpdated: "connections.trustUpdated",
};

/** Connection forms are independent of polling. Entered credentials are never persisted in browser drafts. */
export class ConnectionEditor {
  private epoch = 0;
  private root: HTMLElement | null = null;
  private project = "";
  private items: PublicationConnection[] = [];
  private roots: PublicationRoot[] = [];
  private selected = "";
  private busy = false;
  private pending = crypto.randomUUID();
  private kind: ConnectionInput["connector"] = "local-site";
  private draft = { name: "", url: "https://example.com/" };
  constructor(
    private t: Translate,
    private changed: (connections: PublicationConnection[]) => void,
  ) {}
  close() {
    this.epoch++;
    this.root = null;
  }
  async mount(root: HTMLElement, project: string, selectedId?: string) {
    this.close();
    this.root = root;
    this.project = project;
    this.selected = "";
    this.busy = false;
    this.pending = crypto.randomUUID();
    this.kind = "local-site";
    this.draft = { name: "", url: "https://example.com/" };
    const epoch = this.epoch;
    const [roots, list] = await Promise.all([deliveryApi.roots(), deliveryApi.connections(project)]);
    if (epoch !== this.epoch) return;
    this.roots = roots.roots;
    this.items = list.connections;
    this.selected =
      selectedId === undefined
        ? this.items[0]?.id || ""
        : this.items.some((item) => item.id === selectedId)
          ? selectedId
          : "";
    root.querySelector<HTMLSelectElement>("#connectionPicker")!.onchange = (event) => {
      this.selected = (event.target as HTMLSelectElement).value;
      this.pending = crypto.randomUUID();
      this.kind = "local-site";
      this.draft = { name: "", url: "https://example.com/" };
      this.notice("");
      this.draw();
    };
    this.draw();
    this.changed(this.items);
  }
  private notice(text: string) {
    const element = this.root?.querySelector<HTMLElement>("#connectionNotice");
    if (element) {
      element.textContent = text;
      element.hidden = !text;
    }
  }
  private draw() {
    if (!this.root) return;
    const picker = this.root.querySelector<HTMLSelectElement>("#connectionPicker")!,
      connection = this.items.find((item) => item.id === this.selected) || null;
    setMessageHtml(
      picker,
      `<option value="">${messageHtml("connections.new", undefined, this.t)}</option>` + connectionOptions(this.items),
    );
    picker.value = this.selected;
    const editor = this.root.querySelector<HTMLElement>("#connectionEditor")!;
    setMessageHtml(editor, connectionForm(this.t, this.roots, connection, this.kind, this.draft));
    const form = editor.querySelector<HTMLFormElement>("form")!;
    const connector = form.querySelector<HTMLSelectElement>("#publish-connector")!;
    connector.onchange = () => {
      const values = new FormData(form);
      this.draft = {
        name: String(values.get("publication-name") || ""),
        url: String(values.get("publication-url") || ""),
      };
      this.kind = connector.value === "sftp-site" ? "sftp-site" : "local-site";
      this.pending = crypto.randomUUID();
      this.draw();
    };
    form.onsubmit = (event) => {
      event.preventDefault();
      const values = Object.fromEntries(
        [...new FormData(form)].map(([key, value]) => [key.replace(/^publication-/, ""), value]),
      );
      void this.perform(async () => {
        const common = { name: String(values.name), publicUrl: String(values.url) };
        const result = connection
          ? await deliveryApi.updateConnection(connection.id, {
              ...common,
              version: connection.version,
              enabled: values.enabled === "on",
            })
          : await deliveryApi.createConnection({
              ...common,
              id: this.pending,
              projectId: this.project,
              directory: String(values.directory),
              ...(this.kind === "sftp-site"
                ? {
                    connector: "sftp-site",
                    host: String(values.host),
                    port: Number(values.port),
                    username: String(values.username),
                    hostKey: String(values.hostKey),
                  }
                : { connector: "local-site", root: String(values.root) }),
            });
        return result.connection;
      }, "saved");
    };
    const test = editor.querySelector<HTMLButtonElement>("[data-connection-test]");
    if (test && connection)
      test.onclick = () =>
        void this.perform(async () => {
          return (await deliveryApi.testConnection(connection.id, connection.version)).connection;
        }, "tested");
    if (connection) {
      bindCredentialForm(
        editor,
        (credential) =>
          void this.perform(
            async () => (await deliveryApi.saveCredential(connection.id, connection.version, credential)).connection,
            "saved",
          ),
      );
      bindHostTrustForm(
        editor,
        (hostKey) =>
          void this.perform(
            async () => (await deliveryApi.replaceHostKey(connection.id, connection.version, hostKey)).connection,
            "trustUpdated",
          ),
      );
      const refresh = editor.querySelector<HTMLButtonElement>("[data-connection-refresh]");
      if (refresh)
        refresh.onclick = () =>
          void this.perform(async () => (await deliveryApi.connection(connection.id)).connection, "refreshed");
    }
  }
  private async perform(operation: () => Promise<PublicationConnection | null>, message: EditorNotice) {
    if (this.busy || !this.root) return;
    const epoch = this.epoch,
      root = this.root;
    this.busy = true;
    this.notice(this.t("delivery.working"));
    root
      .querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
        "button,input,select,textarea",
      )
      .forEach((element) => {
        element.disabled = true;
      });
    try {
      const saved = await operation();
      if (epoch !== this.epoch) return;
      if (saved) {
        this.selected = saved.id;
        this.items = [saved, ...this.items.filter((item) => item.id !== saved.id)];
        this.pending = crypto.randomUUID();
        this.changed(this.items);
      }
      this.draw();
      this.notice(this.t(notices[message]));
    } catch (error) {
      if (epoch === this.epoch)
        this.notice(
          errorText(error instanceof DeliveryApiError ? error.payload : null, this.t, "connections.unavailable"),
        );
    } finally {
      if (epoch === this.epoch) {
        this.busy = false;
        root
          .querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
            "button,input,select,textarea",
          )
          .forEach((element) => {
            const selected = this.items.find((item) => item.id === this.selected);
            element.disabled = Boolean(
              (this.selected && element.hasAttribute("data-connection-immutable")) ||
              element.closest("[data-secret-kind][hidden]") ||
              (element.hasAttribute("data-connection-test") &&
                selected?.connector === "sftp-site" &&
                !selected.credentialRevision),
            );
          });
      }
    }
  }
}
