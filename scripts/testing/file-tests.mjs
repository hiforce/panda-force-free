import { spawn } from "node:child_process";

/** Bound the lifetime of native test-worker caches while preserving every discovered file and test timeout. */
export function fileTestBatches(files, size = 24) {
  if (
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > 100 ||
    !files.length ||
    new Set(files).size !== files.length ||
    files.some(
      (file) =>
        typeof file !== "string" ||
        !/^tests\/unit\/[a-zA-Z0-9_./-]+\.test\.ts$/.test(file) ||
        file.split("/").includes(".."),
    )
  )
    throw new Error("Invalid exhaustive unit inventory");
  const batches = [];
  for (let at = 0; at < files.length; at += size) batches.push(files.slice(at, at + size));
  return batches;
}

if (import.meta.main) {
  const files = process.argv.slice(2),
    batches = fileTestBatches(files);
  console.log("Running every unit file in bounded native-worker batches:", files.length);
  for (const [index, batch] of batches.entries()) {
    console.log("Unit batch", index + 1, "of", batches.length, "files", batch.length);
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["test", "--parallel=2", "--max-concurrency=1", ...batch], {
        stdio: "inherit",
      });
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    if (result.code !== 0 || result.signal) {
      console.error("Unit batch failed; the exhaustive unit gate has not passed.");
      process.exit(result.code || 1);
    }
  }
  console.log("All discovered unit files completed:", files.length);
}
