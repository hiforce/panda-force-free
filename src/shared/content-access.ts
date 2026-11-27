export type ContentGrantRole = "reader" | "contributor" | "blocked";
export interface ContentAccessView {
  owner: string;
  administrator: boolean;
  mode: "restricted" | "shared";
  personal: boolean;
  projects: { id: string; name: string; role: Exclude<ContentGrantRole, "blocked">; canManageMembers?: boolean }[];
}
export interface ProjectMemberOptions {
  editable: boolean;
  legacy?: boolean;
  chooseOwner?: boolean;
  revision: number | null;
  members: { id: string; username: string; selected: boolean; creator: boolean }[];
}
export interface ContentGrantSnapshot {
  revision: number;
  projectOwner?: string;
  grants: { owner: string; role: ContentGrantRole; updatedAt: number }[];
}
