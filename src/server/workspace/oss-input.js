import { attachmentUrlName, canonicalAttachmentUrl } from "../../shared/attachment-urls.js";
// Keep complete inputs below the shared daemon message ceiling.
const MAX_INLINE_INPUT_BYTES = 60 * 1024 * 1024;
const IMAGE_REFERENCE = /^Attached image: ("[^\n]*")\n(https:\/\/[^\n]+)$/gm;

/** Restore readable attachment references without persisting inline image bytes. */
export function createOssInputPresenter(urlPrefix) {
  const presentInput = (input) => {
    const references = [];
    for (const part of input) {
      if (part?.type !== "text" || typeof part.text !== "string") continue;
      for (const match of part.text.matchAll(IMAGE_REFERENCE)) {
        const url = canonicalAttachmentUrl(match[2], urlPrefix);
        if (!url) continue;
        try {
          if (JSON.parse(match[1]) === attachmentUrlName(url)) references.push({ url, marker: match[0] });
        } catch {
          /* Unrelated text is not attachment metadata. */
        }
      }
    }
    const images = input.filter((part) => part?.type === "image" && /^data:image\//i.test(part.url || ""));
    if (!references.length || images.length !== references.length) return input;
    let imageIndex = 0;
    return input.flatMap((part) => {
      if (part?.type === "image" && /^data:image\//i.test(part.url || ""))
        return [{ ...part, url: references[imageIndex++].url }];
      if (part?.type !== "text" || typeof part.text !== "string") return [part];
      let text = part.text;
      for (const reference of references) text = text.replaceAll(reference.marker, "");
      if (text === part.text) return [part];
      return text.trim() ? [{ ...part, text: text.trim() }] : [];
    });
  };
  const present = (value) => {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) {
      const input = presentInput(value);
      let changed = input !== value;
      const result = input.map((item) => {
        const next = present(item);
        changed ||= next !== item;
        return next;
      });
      return changed ? result : value;
    }
    let result = value;
    for (const [key, child] of Object.entries(value)) {
      const next = present(child);
      if (next !== child) {
        if (result === value) result = { ...value };
        result[key] = next;
      }
    }
    return result;
  };
  return present;
}

/** Refresh signed links and inline only image inputs required by the native protocol. */
export function createOssInputPreparer({ urlPrefix, keyFromUrl, sign, inlineImage }) {
  return async function prepareInput(input) {
    if (!Array.isArray(input)) return input;
    const signed = new Map();
    const images = new Map();
    const refresh = (value) => {
      if (!canonicalAttachmentUrl(value, urlPrefix)) return Promise.resolve(value);
      const key = keyFromUrl(value);
      if (!signed.has(key)) signed.set(key, sign(key));
      return signed.get(key);
    };
    const prepared = [];
    let inputBytes = 2;
    for (const part of input) {
      let parts;
      if (part?.type === "image" && canonicalAttachmentUrl(part.url, urlPrefix)) {
        const key = keyFromUrl(part.url);
        if (!images.has(key)) images.set(key, inlineImage(key));
        const [url, source] = await Promise.all([images.get(key), refresh(part.url)]);
        parts = [
          { type: "text", text: `Attached image: ${JSON.stringify(attachmentUrlName(part.url))}\n${source}` },
          { ...part, url },
        ];
      } else if (part?.type === "text" && typeof part.text === "string") {
        let text = part.text;
        for (const match of part.text.matchAll(/^Attached file: (".*")\n([^\n]+)$/gm)) {
          try {
            JSON.parse(match[1]);
          } catch {
            continue;
          }
          const url = await refresh(match[2]);
          text = text.replace(match[0], `Attached file: ${match[1]}\n${url}`);
        }
        parts = [{ ...part, text }];
      } else parts = [part];
      for (const value of parts) {
        inputBytes += Buffer.byteLength(JSON.stringify(value) || "null") + 1;
        if (inputBytes > MAX_INLINE_INPUT_BYTES)
          throw new Error("Combined image inputs are too large; send fewer images at a time");
        prepared.push(value);
      }
    }
    return prepared;
  };
}
