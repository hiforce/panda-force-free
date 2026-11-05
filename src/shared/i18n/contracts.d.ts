export interface LocaleDescriptor {
  code: string;
  name: string;
  direction: string;
  formatLocale?: string;
}
export type MessageCatalog = Record<string, Record<string, string>>;
export interface I18nOptions {
  preference?: string;
  languages?: readonly string[];
  registry?: readonly LocaleDescriptor[];
  resources?: Record<string, MessageCatalog>;
  loaders?: Record<string, () => Promise<MessageCatalog>>;
  persist?: (preference: string) => void;
  onMissing?: (id: string, locale: string, error?: unknown) => void;
  onLoadError?: (locale: string, error: unknown) => void;
  timeZone?: string;
}
export interface BrowserI18nOptions extends I18nOptions {
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  document?: Document | null;
}
