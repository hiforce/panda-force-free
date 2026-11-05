export function renderDiffLine(line, escapeHtml) {
  if (!line) return '<div class="review-line empty"><span class="review-sign"></span><code></code></div>';
  return `<div class="review-line ${line.type}"><span class="review-sign">${line.type === "add" ? "+" : line.type === "delete" ? "−" : " "}</span><code>${escapeHtml(line.text)}</code></div>`;
}
