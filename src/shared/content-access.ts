export type ContentGrantRole = "reader" | "contributor" | "blocked";
export interface ContentAccessView {
  owner: string;
  administrator: boolean;
  mode: "restricted" | "shared";
  personal: boolean;
  projects: { id: string; name: string; role: Exclude<ContentGrantRole, "blocked"> }[];
}
export interface ContentGrantSnapshot {
  revision: number;
  grants: { owner: string; role: ContentGrantRole; updatedAt: number }[];
}
