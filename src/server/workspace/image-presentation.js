import { resolveLocalImage } from "./images.js";

// Native generation items include both a durable local image and its base64
// result. Browser history needs only the file reference, never another copy of
// the image inside its JSON. Leave native/model state untouched.
export function createLocalImagePresenter(options) {
  function present(value) {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) {
      const result = value.map(present);
      return result.some((child, index) => child !== value[index]) ? result : value;
    }
    let result = value;
    if (value.type === "imageGeneration" && typeof value.savedPath === "string" && typeof value.result === "string") {
      try {
        resolveLocalImage(value.savedPath, options);
        const { result: omitted, ...metadata } = value;
        result = metadata;
      } catch {
        // Keep the original representation if the saved image is unavailable.
      }
    }
    for (const [key, child] of Object.entries(result)) {
      const next = present(child);
      if (next !== child) {
        if (result === value) result = { ...value };
        result[key] = next;
      }
    }
    return result;
  }
  return present;
}
