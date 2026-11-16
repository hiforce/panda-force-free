import { createPrivateKey, randomBytes, type KeyObject } from "node:crypto";
import { utils } from "ssh2";
import { ConnectionError } from "../errors.js";
import { OPENSSH_PRIVATE_KEY_BEGIN, OPENSSH_PRIVATE_KEY_END } from "./ssh-key-markers.js";

/** Inspect untrusted KDF parameters before invoking the synchronous SSH key parser. */
function boundedOpenSsh(key: string) {
  if (!key.startsWith(OPENSSH_PRIVATE_KEY_BEGIN)) return;
  const encoded = key
    .replace(new RegExp("^" + OPENSSH_PRIVATE_KEY_BEGIN + "\\s*"), "")
    .replace(new RegExp("\\s*" + OPENSSH_PRIVATE_KEY_END + "$"), "");
  const bytes = Buffer.from(encoded, "base64");
  let offset = 15;
  const field = () => {
    if (offset + 4 > bytes.length) throw new ConnectionError("invalidCredential");
    const size = bytes.readUInt32BE(offset);
    offset += 4;
    if (size > bytes.length - offset) throw new ConnectionError("invalidCredential");
    const value = bytes.subarray(offset, offset + size);
    offset += size;
    return value;
  };
  if (bytes.subarray(0, 15).toString() !== "openssh-key-v1\0") throw new ConnectionError("invalidCredential");
  const cipher = field().toString(),
    kdf = field().toString(),
    options = field();
  if (kdf === "bcrypt") {
    if (cipher === "none" || options.length < 8) throw new ConnectionError("invalidCredential");
    const salt = options.readUInt32BE(0);
    if (salt < 1 || salt > 64 || options.length !== salt + 8) throw new ConnectionError("invalidCredential");
    const rounds = options.readUInt32BE(salt + 4);
    if (rounds < 1 || rounds > 64) throw new ConnectionError("keyWorkLimit");
  } else if (kdf !== "none" || cipher !== "none" || options.length) throw new ConnectionError("invalidCredential");
  if (offset + 4 > bytes.length || bytes.readUInt32BE(offset) !== 1) throw new ConnectionError("invalidCredential");
}

/** ssh2 accepts Ed25519 in OpenSSH format, whereas its PEM getter returns PKCS#8. */
function openSshEd25519(key: KeyObject, publicKey: Buffer) {
  const jwk = key.export({ format: "jwk" });
  if (!jwk.d || !jwk.x) throw new ConnectionError("invalidCredential");
  const seed = Buffer.from(jwk.d, "base64url"),
    publicBytes = Buffer.from(jwk.x, "base64url");
  if (seed.length !== 32 || publicBytes.length !== 32) throw new ConnectionError("invalidCredential");
  const integer = (value: number) => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(value);
    return bytes;
  };
  const field = (value: string | Buffer) => {
    const bytes = Buffer.from(value);
    return Buffer.concat([integer(bytes.length), bytes]);
  };
  if (!publicKey.equals(Buffer.concat([field("ssh-ed25519"), field(publicBytes)])))
    throw new ConnectionError("invalidCredential");
  const check = randomBytes(4);
  const body = Buffer.concat([
    check,
    check,
    field("ssh-ed25519"),
    field(publicBytes),
    field(Buffer.concat([seed, publicBytes])),
    field(""),
  ]);
  seed.fill(0);
  const padding = Buffer.from(Array.from({ length: (8 - (body.length % 8)) % 8 }, (_, index) => index + 1));
  const bytes = Buffer.concat([
    Buffer.from("openssh-key-v1\0"),
    field("none"),
    field("none"),
    field(""),
    integer(1),
    field(publicKey),
    field(Buffer.concat([body, padding])),
  ]);
  const encoded = bytes
    .toString("base64")
    .match(/.{1,70}/g)!
    .join("\n");
  body.fill(0);
  bytes.fill(0);
  return [OPENSSH_PRIVATE_KEY_BEGIN, encoded, OPENSSH_PRIVATE_KEY_END, ""].join("\n");
}

/** Persist a normalized key inside the encrypted envelope; future connections need no password KDF. */
export function normalizedSshKey(value: string, passphrase: string) {
  const privateKey = value.trim();
  boundedOpenSsh(privateKey);
  const parsed = utils.parseKey(privateKey, passphrase || undefined);
  if (parsed instanceof Error || Array.isArray(parsed) || !parsed.isPrivateKey())
    throw new ConnectionError("invalidCredential");
  try {
    const pem = parsed.getPrivatePEM(),
      key = createPrivateKey(pem);
    if ((key.asymmetricKeyDetails?.modulusLength || 0) > 8192) throw new ConnectionError("keyWorkLimit");
    return key.asymmetricKeyType === "ed25519" ? openSshEd25519(key, parsed.getPublicSSH()) : pem;
  } catch (error) {
    if (error instanceof ConnectionError) throw error;
    throw new ConnectionError("invalidCredential");
  }
}
