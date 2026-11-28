import { registeredStorageId, storageConnectionsPath, storageToolsPath, type StorageProvider } from "./storage.js";

export const storageBrowserApiPath = storageConnectionsPath + "/browse";
export const storageBrowserDownloadPath = storageBrowserApiPath + "/download";
export const storageBrowserConnectionId = (id: string) => registeredStorageId.test(id) || /^s-[a-f0-9]{40}$/.test(id);

export function storageBrowserPath(id: string) {
  return storageToolsPath + "/browse/" + encodeURIComponent(id);
}
export function storageBrowserId(path: string) {
  const id = /^\/tools\/storage\/browse\/([a-z0-9-]+)\/?$/.exec(path)?.[1];
  return id && storageBrowserConnectionId(id) ? id : null;
}

export interface StorageBrowserEntry {
  kind: "folder" | "file";
  id: string;
  name: string;
  bytes?: number;
  modified?: string;
  openUrl?: string;
  download?: boolean;
}
export interface StorageBrowserPage {
  name: string;
  provider: StorageProvider;
  location: string;
  path: { id: string; name: string }[];
  parent: string;
  entries: StorageBrowserEntry[];
  next: string;
}
