// A tab can remain open across a deployment; accept both generations of hints.
export function splitBrowserRpcParams(input = {}) {
  const { pandaProjectless, pandaPrepareInput, pandaProjectId, webuiProjectless, webuiPrepareInput, ...params } =
    input || {};
  return {
    params,
    flags: {
      pandaProjectless: pandaProjectless === undefined ? webuiProjectless : pandaProjectless,
      pandaPrepareInput: pandaPrepareInput === undefined ? webuiPrepareInput : pandaPrepareInput,
      ...(pandaProjectId === undefined ? {} : { pandaProjectId }),
    },
  };
}
