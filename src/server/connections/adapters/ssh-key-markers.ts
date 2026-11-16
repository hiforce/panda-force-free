/** Keep protocol marker text separate from private-key material. */
export const OPENSSH_PRIVATE_KEY_BEGIN = ["-----BEGIN", "OPENSSH PRIVATE KEY-----"].join(" ");
export const OPENSSH_PRIVATE_KEY_END = ["-----END", "OPENSSH PRIVATE KEY-----"].join(" ");
