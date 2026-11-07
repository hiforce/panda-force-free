import type { DataView } from "../../shared/data-view.js";
import type { EngineItem } from "../../shared/engine/types.js";

export interface ConversationRenderContext {
  item: DataView<EngineItem>;
  turnId: string;
  root: HTMLElement;
  element: HTMLElement | null;
}

/** Trusted, bundled renderers consume normalized items; they never own scrolling. */
export interface ConversationRenderer {
  id: string;
  types: readonly string[];
  /** A specialized renderer precedes the general renderer for the same type. */
  matches?: (item: DataView<EngineItem>) => boolean;
  /** Grouped activities own their children instead of a single item root. */
  itemRoot?: boolean;
  render: (context: ConversationRenderContext) => HTMLElement | null;
  /** Release external listeners or resources when a root is permanently retired. */
  dispose?: (element: HTMLElement) => void;
}

/** Explicit capabilities supplied to built-ins; extension payloads cannot grant new capabilities. */
export interface ConversationRendererServices {
  state: import("../contracts/ownership.js").StateReader<"messages">;
  mutations: import("../contracts/ownership.js").StateWriter<"messages">;
  t: import("../../shared/i18n/messages.js").Translate;
  viewUpdates: import("../contracts/features.js").EnvironmentPort["viewUpdates"];
  turnFramesPort: import("../contracts/features.js").TurnFramesPort;
  activityPort: import("../contracts/features.js").ActivityPort;
  submissionPort: import("../contracts/features.js").SubmissionPort;
  timingPort: import("../contracts/features.js").TimingPort;
  queuePort: import("../contracts/features.js").QueuePort;
  identityPort: import("../contracts/features.js").IdentityPort;
  clipboardPort: import("../contracts/features.js").ClipboardPort;
  reviewPort: import("../contracts/features.js").ReviewPort;
  sideTasksPort: import("../contracts/features.js").SideTasksPort;
}
