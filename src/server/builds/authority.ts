import type { BuildInput } from "../../shared/builds/contracts.js";
import { SiteBuildError } from "./errors.js";

export type BuildAuthorityPort = (input: BuildInput) => void | Promise<void>;
export type BuildAuthority = (input: BuildInput) => void;
/** Package-bound themes require installed authority. Built-in declarative snapshots remain independent. */
export const builtinBuildAuthority: BuildAuthority = (input) => {
  if (input.theme?.package) throw new SiteBuildError("themeNotApproved", 403);
};
