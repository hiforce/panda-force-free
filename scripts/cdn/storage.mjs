import { S3Client } from "bun";

export function cdnConfiguration(env = process.env) {
  if (!env.PANDA_FORCE_CDN_BASE_URL) return null;
  const url = new URL(env.PANDA_FORCE_CDN_BASE_URL);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new Error("PANDA_FORCE_CDN_BASE_URL must be a public HTTPS URL without credentials or query parameters");
  for (const key of ["PANDA_FORCE_CDN_BUCKET", "AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"])
    if (!env[key]) throw new Error("CDN build requires " + key);
  if (env.PANDA_FORCE_CDN_S3_ENDPOINT) {
    const endpoint = new URL(env.PANDA_FORCE_CDN_S3_ENDPOINT);
    if (
      !["https:", "http:"].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw new Error("Invalid S3 endpoint");
  }
  const prefix = env.PANDA_FORCE_CDN_PREFIX || "pandaforce/static";
  if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(prefix)) throw new Error("Invalid CDN object prefix");
  return {
    baseUrl: url.href.replace(/\/$/, ""),
    prefix,
    bucket: env.PANDA_FORCE_CDN_BUCKET,
    region: env.AWS_REGION,
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    sessionToken: env.AWS_SESSION_TOKEN,
    endpoint: env.PANDA_FORCE_CDN_S3_ENDPOINT,
  };
}

/** Only short-lived signed URLs leave this adapter; credentials never enter build output. */
export function s3Storage(config) {
  const client = new S3Client(config);
  const request = async (key, method, body, type, immutable) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      let response;
      try {
        response = await fetch(client.file(key).presign({ method, expiresIn: 120 }), {
          method,
          body,
          headers:
            method === "PUT"
              ? {
                  "Content-Type": type,
                  "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
                }
              : {},
          signal: AbortSignal.timeout(60_000),
        });
      } catch {
        if (attempt === 2) throw new Error(`S3 ${method} failed for ${key}`);
      }
      if (response && response.status < 500 && response.status !== 429) {
        if (method === "GET" && response.status === 404) return null;
        if (!response.ok) throw new Error(`S3 ${method} returned ${response.status} for ${key}`);
        return Buffer.from(await response.arrayBuffer());
      }
      if (attempt === 2) throw new Error(`S3 ${method} unavailable for ${key}`);
      await Bun.sleep(250 * 2 ** attempt);
    }
  };
  return {
    get: (key) => request(key, "GET"),
    put: (key, body, type, immutable = true) => request(key, "PUT", body, type, immutable),
  };
}
