/** Browsers reject an unexecuted ESM fetch with these native TypeError messages; other initialization errors stay fatal. */
export function isModuleNetworkError(cause: unknown) {
  return (
    cause instanceof TypeError &&
    /^(?:Failed to fetch dynamically imported module(?::|$)|Importing a module script failed\.?$|error loading dynamically imported module:)/i.test(
      cause.message,
    )
  );
}
