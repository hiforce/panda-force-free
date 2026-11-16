import type { GadgetRow } from "./ports.js";
import type { DataView } from "../../shared/data-view.js";
import type { SessionSummary } from "../../shared/engine/types.js";
import type { ProductProject } from "../../shared/data-contracts.js";
/** Route admission is an application policy, separate from the generic layout host. */
export function gadgetApplicationNavigation(navigate: (path: string) => void) {
  return (path: string) => {
    if (
      /^\/(?:task\/|tasks(?:\?|$)|project(?:\?|s(?:\?|$))|skills(?:\?|\/|$)|bots(?:\?|$)|create(?:\?|$)|publish(?:\?|$)|documents(?:\?|$))/.test(
        path,
      ) &&
      !/[\\\r\n\0]/.test(path)
    )
      navigate(path);
  };
}
export interface ComposerCapability {
  identity: string;
  creationProject(): string;
  navigate(path: string): void;
  projects(): GadgetRow[];
  startTask(prompt: string, project: string): void;
  taskDraft(project: string): string;
  creationClosed?(): void;
}
export interface ProjectionCapability {
  ready(): boolean;
  rows(): GadgetRow[];
}
export interface CreationActivityCapability {
  identity: string;
  navigate(path: string): void;
  projects(): { id: string; name: string }[];
}
/** Application adapters belong to system gadgets, never to the generic layout host. */
export function systemGadgetCapabilities(options: {
  identity: string;
  navigate(path: string): void;
  creationProject(): string;
  startTask(prompt: string, project: string): void;
  taskDraft(project: string): string;
  ready(): boolean;
  sessions(): DataView<SessionSummary>[];
  projects(): ProductProject[];
  projectForSession(id: string): DataView<ProductProject> | null;
  status(session: DataView<SessionSummary>): string;
}) {
  const projects = () => options.projects().map((p) => ({ id: p.id, title: p.name, description: p.code }));
  const composer: ComposerCapability = {
    identity: options.identity,
    navigate: options.navigate,
    creationProject: options.creationProject,
    startTask: options.startTask,
    taskDraft: options.taskDraft,
    projects,
  };
  const sessions: ProjectionCapability = {
    ready: options.ready,
    rows: () =>
      options.sessions().map((s) => ({
        id: s.id,
        title: s.name || s.preview || "",
        description: options.projectForSession(s.id)?.name || "",
        status:
          (
            {
              "common.inProgress": "running",
              "workbench.needsReview": "review",
              "sessions.completed": "done",
              "common.failed": "error",
            } as Record<string, string>
          )[options.status(s)] || "ready",
      })),
  };
  return new Map<string, unknown>([
    ["panda.composer", composer],
    ["panda.sessions", sessions],
    ["panda.projects", { ready: options.ready, rows: projects } satisfies ProjectionCapability],
    [
      "panda.creations",
      {
        identity: options.identity,
        navigate: options.navigate,
        projects: () => options.projects().map(({ id, name }) => ({ id, name })),
      } satisfies CreationActivityCapability,
    ],
  ]);
}
