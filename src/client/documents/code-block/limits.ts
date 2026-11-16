/** Syntax display has a fixed linear scan budget; oversized input remains intact as plain code. */
export function codeHighlightAllowed(text: string): boolean {
  if (text.length > 256 * 1024) return false;
  let column = 0;
  for (let index = 0; index < text.length; index++) {
    column = text.charCodeAt(index) === 10 ? 0 : column + 1;
    if (column > 8192) return false;
  }
  return true;
}
