import manifest from "./suites.json" with { type: "json" };

/** The runner and image certificate use the same exhaustive, ordered plan. */
export const verificationPlan: readonly string[] = Object.freeze([
  "i18n-contracts",
  "check",
  "lint",
  "format",
  "comments",
  "build-client",
  "unit",
  "integration",
  ...manifest.browser.map((name) => name.split("/").at(-1)!),
]);
