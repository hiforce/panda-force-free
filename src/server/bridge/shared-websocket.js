import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
// Bun's built-in `ws` shim ignores the `fin` option. Use the installed ws
// implementation so a large inline image can use standard continuation frames.
export const SharedWebSocket = require(join(dirname(require.resolve("ws/package.json")), "lib/websocket.js"));
const FRAME_BYTES = 1024 * 1024;

export function sendSharedMessage(socket, message) {
  const text = JSON.stringify(message);
  if (Buffer.byteLength(text) <= FRAME_BYTES) {
    socket.send(text);
    return;
  }
  const bytes = Buffer.from(text);
  for (let start = 0; start < bytes.length; start += FRAME_BYTES) {
    const end = Math.min(start + FRAME_BYTES, bytes.length);
    socket.send(bytes.subarray(start, end), { binary: false, fin: end === bytes.length });
  }
}
