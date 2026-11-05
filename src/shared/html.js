/** Escape a value for HTML text and quoted attribute contexts.
 * @param {unknown} value
 */
export function escapeHtml(value = "") {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
  );
}
