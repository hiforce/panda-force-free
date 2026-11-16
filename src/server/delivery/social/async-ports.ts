import type { SocialSources } from "./ports.js";
export type AsyncSocialGuard = () => void | Promise<void>;
/** Native composition awaits relational source/review guards inside its transaction. */
export interface AsyncSocialSources extends Omit<SocialSources, "authorize" | "space"> {
  authorize(...args: Parameters<SocialSources["authorize"]>): AsyncSocialGuard | Promise<AsyncSocialGuard>;
  space(...args: Parameters<SocialSources["space"]>): AsyncSocialGuard | Promise<AsyncSocialGuard>;
}
