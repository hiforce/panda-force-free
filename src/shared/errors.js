/** Read a diagnostic field without assuming that a thrown value is an Error. */
/** @param {unknown} error */
export function errorMessage(error, fallback = "Unexpected error") {
  if (error instanceof Error) return error.message || fallback;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string")
    return error.message;
  return typeof error === "string" && error ? error : fallback;
}
/** @param {unknown} error */
export function errorCode(error) {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "";
}
/** @param {unknown} error */
export function errorStatus(error, fallback = 0) {
  return error &&
    typeof error === "object" &&
    "status" in error &&
    typeof error.status === "number" &&
    Number.isInteger(error.status)
    ? error.status
    : fallback;
}

/** @param {unknown} error */
export function isTransportSwitch(error) {
  return Boolean(error && typeof error === "object" && "silentTransportSwitch" in error && error.silentTransportSwitch);
}
