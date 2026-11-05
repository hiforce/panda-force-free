// Lost acknowledgements are not evidence that a mutation was rejected.
// Callers keep unconfirmed input visible and never replay it automatically.
export function deliveryIsUncertain(error, dispatched) {
  return Boolean(
    dispatched &&
    (error?.silentTransportSwitch ||
      error instanceof TypeError ||
      error?.name === "AbortError" ||
      /timed out|app-server exited/i.test(error?.message || "")),
  );
}
