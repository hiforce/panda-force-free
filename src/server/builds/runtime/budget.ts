/** Reserve encoded bytes and manifest overhead before collecting an execution result. */
export const artifactStorageBudget = (bytes: number, files: number) => bytes * 1.4 + files * 1400 + 2048;
