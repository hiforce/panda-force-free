import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP, BlockList } from "node:net";
import { botHttps, BotError } from "../../shared/bots/contracts.js";

const denied = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  denied.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  denied.addSubnet(address, prefix, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
export function publicBotAddress(address: string): boolean {
  return isIP(address) === 4
    ? !denied.check(address, "ipv4")
    : isIP(address) === 6 && globalV6.check(address, "ipv6") && !denied.check(address, "ipv6");
}
/** Resolve once and pin the connection address; do not follow redirects or use ambient credentials. */
export async function botRequest(
  value: string,
  options: {
    method: "GET" | "POST";
    body?: string;
    headers?: Record<string, string>;
    maxBytes: number;
    signal: AbortSignal;
  },
) {
  const url = botHttps(value),
    addresses = await Promise.race([
      lookup(url.hostname, { all: true }),
      new Promise<never>((_resolve, reject) => {
        if (options.signal.aborted) reject(new Error("Aborted"));
        else options.signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
      }),
    ]);
  if (!addresses.length || addresses.some((a) => !publicBotAddress(a.address))) throw new BotError("targetDenied", 403);
  const target = addresses[0]!;
  options.signal.throwIfAborted();
  return await new Promise<{ status: number; type: string; body: Buffer }>((resolve, reject) => {
    const req = request(
      url,
      {
        method: options.method,
        agent: false,
        family: target.family,
        signal: options.signal,
        headers: options.headers,
        lookup: ((_hostname: unknown, _options: unknown, done: Function) =>
          done(null, target.address, target.family)) as never,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > options.maxBytes) res.destroy(new Error("Response too large"));
          else chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            type: String(res.headers["content-type"] ?? ""),
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}
