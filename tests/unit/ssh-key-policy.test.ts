import {
  OPENSSH_PRIVATE_KEY_BEGIN,
  OPENSSH_PRIVATE_KEY_END,
} from "../../src/server/connections/adapters/ssh-key-markers.js";
import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { utils } from "ssh2";
import { sftpCredential } from "../../src/server/connections/adapters/sftp-input.js";

function openSshHeader(rounds: number, saltSize = 16) {
  const integer = (number: number) => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(number);
    return bytes;
  };
  const field = (value: string | Buffer) => {
    const bytes = Buffer.from(value);
    return Buffer.concat([integer(bytes.length), bytes]);
  };
  const options = Buffer.concat([field(Buffer.alloc(saltSize)), integer(rounds)]);
  const bytes = Buffer.concat([
    Buffer.from("openssh-key-v1\0"),
    field("aes256-ctr"),
    field("bcrypt"),
    field(options),
    integer(1),
  ]);
  return [OPENSSH_PRIVATE_KEY_BEGIN, bytes.toString("base64"), OPENSSH_PRIVATE_KEY_END].join("\n");
}

test("private-key parsing rejects excessive KDF work before invoking the cryptographic parser", () => {
  for (const rounds of [0, 65, 4294967295])
    expect(() => sftpCredential({ method: "privateKey", privateKey: openSshHeader(rounds) })).toThrow("keyWorkLimit");
  expect(() => sftpCredential({ method: "privateKey", privateKey: openSshHeader(16, 128) })).toThrow(
    "invalidCredential",
  );
});

test("RSA and EC credentials normalize to the same key without retaining the input passphrase", () => {
  const pairs = [
    { key: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey, type: "pkcs1" as const },
    { key: generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey, type: "sec1" as const },
  ];
  for (const { key, type } of pairs) {
    const passphrase = "disposable-test-passphrase";
    const original = String(key.export({ format: "pem", type, cipher: "aes-256-cbc", passphrase }));
    const normalized = sftpCredential({ method: "privateKey", privateKey: original, passphrase });
    expect(normalized.passphrase).toBeUndefined();
    expect(String(normalized.privateKey)).not.toContain("ENCRYPTED");
    const before = utils.parseKey(original, passphrase),
      after = utils.parseKey(String(normalized.privateKey));
    if (before instanceof Error || after instanceof Error || Array.isArray(before) || Array.isArray(after))
      throw new Error("Expected single parsed private keys");
    expect(after.getPublicSSH()).toEqual(before.getPublicSSH());
  }
});
