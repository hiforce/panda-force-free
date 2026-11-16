import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pandaEnvironment } from "./environment.js";

/** Product persistence is independent of the selected model engine's home directory. */
export function productStateRoot(source: NodeJS.ProcessEnv = process.env) {
  const env = pandaEnvironment(source);
  return resolve(env.PANDA_FORCE_HOME || join(env.HOME || homedir(), ".panda-force"));
}
