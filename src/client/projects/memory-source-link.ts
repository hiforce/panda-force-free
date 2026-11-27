import { harnessConversationId, harnessId } from "../../shared/harness/presentation.js";
import type { MemoryEntry } from "../../shared/project-memory/contracts.js";

export const memoryMapLayouts = ["network", "timeline", "focus"] as const;
export type MemoryMapLayout = (typeof memoryMapLayouts)[number];
export const memoryMapLayout = (value: unknown) => memoryMapLayouts.find((layout) => layout === value);

export type MemoryView = "terrain" | "evidence" | "records";
export interface MemoryBrowse {
  mode: MemoryView;
  topic?: string;
  plate?: string;
  place?: string;
  layout?: MemoryMapLayout;
  hops?: 1 | 2;
}

export function memoryBrowse(params: URLSearchParams): MemoryBrowse {
  const mode = params.get("memoryView");
  const digest = (key: string) => {
    const value = params.get(key);
    return value && /^[a-f0-9]{64}$/u.test(value) ? value : undefined;
  };
  return {
    mode: mode === "evidence" || mode === "records" ? mode : "terrain",
    topic: digest("topic"),
    plate: digest("plate"),
    place: digest("place"),
    layout: memoryMapLayout(params.get("mapLayout")),
    hops: params.get("hops") === "1" ? 1 : undefined,
  };
}

function browseParams(params: URLSearchParams, browse: MemoryBrowse) {
  params.set("memoryView", browse.mode);
  for (const key of ["topic", "plate", "place"] as const) {
    if (browse[key]) params.set(key, browse[key]);
    else params.delete(key);
  }
  if (browse.layout) params.set("mapLayout", browse.layout);
  else params.delete("mapLayout");
  if (browse.layout === "focus" && browse.hops === 1) params.set("hops", "1");
  else params.delete("hops");
  return params;
}

export const conversationHref = (id: string) => "/task/" + encodeURIComponent(harnessConversationId(id));

export function memorySourceHref(project: string, source: MemoryEntry["sources"][number], browse?: MemoryBrowse) {
  const params = new URLSearchParams({ project, memoryMessage: source.messageId });
  if (browse) browseParams(params, browse);
  return conversationHref(source.conversationId) + "?" + params;
}

export function rememberMemoryBrowse(project: string, browse: MemoryBrowse) {
  const url = new URL(location.href);
  if (url.pathname !== "/project" || url.searchParams.get("tab") !== "memory" || url.searchParams.get("id") !== project)
    return;
  browseParams(url.searchParams, browse);
  if (url.href !== location.href) history.replaceState(history.state, "", url);
}

export function parseMemorySource(url: URL, id: string) {
  const conversation = harnessId(id);
  const project = url.searchParams.get("project") ?? "";
  const message = url.searchParams.get("memoryMessage") ?? "";
  if (
    !conversation ||
    project === "personal" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(project) ||
    !/^[a-zA-Z0-9:_-]{1,128}$/u.test(message)
  )
    return null;
  const back = browseParams(new URLSearchParams({ id: project, tab: "memory" }), memoryBrowse(url.searchParams));
  return {
    conversation,
    message,
    project,
    back: "/project?" + back,
  };
}

export function memoryTeamLink(project: string, entry: string) {
  return "/project?" + new URLSearchParams({ id: project, tab: "memory", memoryView: "records", shared: entry });
}
