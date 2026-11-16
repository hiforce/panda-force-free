/** Serialized originals include JSON escaping and resource metadata in addition to the bounded source bodies. */
export const PROJECT_CONTENT_LIMITS = Object.freeze({
  fileBytes: 32 * 1024 * 1024,
  operationBytes: 64 * 1024 * 1024,
  files: 10000,
  journalBytes: 4 * 1024 * 1024,
  intentBytes: 4 * 1024 * 1024,
  gitBytes: 32 * 1024 * 1024,
});
