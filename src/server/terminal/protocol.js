/** Shared validation for terminal resize control frames. */
export function normalizeTerminalResize(message) {
  if (!message || message.type !== "resize") return null;
  const cols = Number(message.cols);
  const rows = Number(message.rows);
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || cols > 500 || rows < 5 || rows > 200)
    return null;
  return { cols, rows };
}

const names = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_COLLATE",
  "LC_NUMERIC",
  "LC_TIME",
  "LC_MONETARY",
  "TZ",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SystemRoot",
  "COMSPEC",
  "PATHEXT",
]);

/** A privileged host terminal still has host access; this prevents incidental service-secret inheritance.
 * @param {NodeJS.ProcessEnv} [source]
 * @returns {Record<string, string>}
 */
export function terminalEnvironment(source = process.env) {
  const result = { TERM: "xterm-256color", COLORTERM: "truecolor" };
  for (const name of names) if (typeof source[name] === "string") result[name] = source[name];
  return result;
}
