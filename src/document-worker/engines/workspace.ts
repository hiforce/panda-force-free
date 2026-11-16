export interface EngineWorkspace {
  dependencies?: Record<string, string>;
  root: string;
  toolchain: string;
  put(path: string, value: string | Uint8Array): Promise<void>;
  installed: { directory: string; entry: string | null } | null;
}
