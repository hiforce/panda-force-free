import type { SelectedElement } from "../dom-elements.js";
import type { LocaleDescriptor } from "../../shared/i18n/contracts.js";
import type { Translate } from "../../shared/i18n/messages.js";

export type DomLookup = <S extends string>(selector: S, root?: ParentNode | null) => SelectedElement<S>;
export interface Formatters {
  list(values: readonly string[], options?: Intl.ListFormatOptions): string;
  number(value: number, options?: Intl.NumberFormatOptions): string;
  percent(value: number, options?: Intl.NumberFormatOptions): string;
  currency(value: number, currency: string, options?: Intl.NumberFormatOptions): string;
  dateTime(value: number | string | Date, options?: Intl.DateTimeFormatOptions): string;
  relativeTime(value: number, unit: Intl.RelativeTimeFormatUnit, options?: Intl.RelativeTimeFormatOptions): string;
  compare(left: string, right: string): number;
  duration(milliseconds: number): string;
}
export interface I18nRuntime {
  readonly t: Translate;
  readonly format: Formatters;
  readonly preference: string;
  readonly locale: string;
  readonly direction: string;
  readonly locales: readonly LocaleDescriptor[];
  has(id: string): boolean;
  setPreference(preference: string, options?: { save?: boolean }): Promise<boolean>;
  setLanguages(languages: readonly string[]): Promise<boolean>;
  setTimeZone(timeZone?: string): void;
  subscribe(listener: () => void): () => void;
  registerNamespace(
    owner: string,
    catalogs: { en: Record<string, string>; translations?: Record<string, Record<string, string>> },
  ): Promise<void>;
}
export interface RequestGate {
  next(): number;
  isCurrent(generation: number): boolean;
  readonly current: number;
}
export interface ConfigurationReadiness {
  readonly ready: Promise<void>;
  start(promise: Promise<void>): void;
}
export interface RenderBatch {
  readonly active: boolean;
  begin(): void;
  end(turnId: string): void;
  subscribe(listener: (turnId: string) => void): () => void;
}
export type PreparationStep =
  "interface" | "connection" | "configuration" | "projects" | "sessions" | "models" | "permissions";
export interface WorkspacePreparation {
  refresh(): void;
  begin(): void;
  start(step: PreparationStep): void;
  complete(step: PreparationStep): void;
  fail(step: PreparationStep): void;
  track<T>(step: PreparationStep, pending: Promise<T>): Promise<T>;
  registerRetry(step: PreparationStep, callback: () => unknown): void;
  retry(): Promise<PromiseSettledResult<unknown>[]>;
  dispose(): void;
}
export interface AnchoredMenu {
  toggle(trigger: HTMLElement, menu: HTMLElement): void;
  close(restoreFocus?: boolean): void;
  closeFor(container?: Element | null): void;
  dispose(): void;
}
