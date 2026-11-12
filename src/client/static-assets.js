/** Resolve runtime-computed static paths using the manifest embedded by a CDN build.
 * @param {string} path
 * @returns {string}
 */
export function staticAssetUrl(path) {
  const data = globalThis.document?.getElementById("pandaStaticAssets")?.textContent;
  if (!data) return path;
  const urls = JSON.parse(data);
  return urls[path.split(/[?#]/)[0]] || path;
}
