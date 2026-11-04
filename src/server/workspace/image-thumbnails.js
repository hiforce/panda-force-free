import sharp from "sharp";

// Limit native work independently of the machine's CPU count. These images are
// only for the activity timeline; the model and original-image route are unchanged.
sharp.concurrency(1);
sharp.cache({ memory: 16, files: 0, items: 20 });

export function createImageThumbnailCache({ maxBytes = 32 * 1024 * 1024, maxEntries = 256 } = {}) {
  const cache = new Map();
  const pending = new Map();
  const waiting = [];
  let cachedBytes = 0;
  let active = 0;

  async function render(image) {
    if (active >= 2) await new Promise((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await sharp(image.path, { limitInputPixels: 40_000_000, failOn: "error" })
        .rotate()
        .resize({ width: 640, height: 640, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 72, effort: 3 })
        .timeout({ seconds: 15 })
        .toBuffer();
    } finally {
      if (waiting.length) waiting.shift()();
      else active--;
    }
  }

  return async function thumbnail(image) {
    // Resolve/authorize the file before every call, including cache hits. A file
    // replaced at the same path must generate a new thumbnail.
    const key = JSON.stringify([image.path, image.size, image.mtimeMs, image.ctimeMs]);
    const cached = cache.get(key);
    if (cached) {
      cache.delete(key);
      cache.set(key, cached);
      return cached;
    }
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= 32) throw Object.assign(new Error("Image thumbnail queue is full"), { status: 503 });
    const task = render(image).then((bytes) => {
      if (bytes.length <= maxBytes) {
        cache.set(key, bytes);
        cachedBytes += bytes.length;
        while (cachedBytes > maxBytes || cache.size > maxEntries) {
          const oldest = cache.keys().next().value;
          cachedBytes -= cache.get(oldest).length;
          cache.delete(oldest);
        }
      }
      return bytes;
    });
    pending.set(key, task);
    try {
      return await task;
    } finally {
      pending.delete(key);
    }
  };
}
