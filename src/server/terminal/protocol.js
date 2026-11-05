/** Shared validation for terminal resize control frames. */
export function normalizeTerminalResize(message) {
  if (!message || message.type !== "resize") return null;
  const cols = Number(message.cols);
  const rows = Number(message.rows);
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || cols > 500 || rows < 5 || rows > 200)
    return null;
  return { cols, rows };
}
