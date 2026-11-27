export const pmfMagic = Uint8Array.of(0x50, 0x4d, 0x46, 1);
export const pmfSegmentedMagic = Uint8Array.of(0x50, 0x4d, 0x46, 2);
export const pmfFingerprintBytes = 32;
export const pmfWrappedKeyBytes = 384;
export const pmfNonceBytes = 12;
export const pmfTagBytes = 16;
export const pmfHeaderBytes = pmfMagic.length + pmfFingerprintBytes + pmfWrappedKeyBytes + pmfNonceBytes;
export const pmfMinimumBytes = pmfHeaderBytes + pmfTagBytes + 22;
export const pmfFrameBytes = 1024 * 1024;

export function pmfVersion(bytes: Uint8Array): 1 | 2 | undefined {
  if (!pmfMagic.subarray(0, 3).every((value, index) => bytes[index] === value)) return;
  const version = bytes[3];
  if (version === 1 || version === 2) return version;
}

export function isPmf(bytes: Uint8Array): boolean {
  return pmfVersion(bytes) !== undefined;
}
