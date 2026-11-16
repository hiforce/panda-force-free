import { runLoggedProcess } from "./supervisor.js";

interface ManagedProcessOptions {
  command: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  logging: { enabled: boolean; directory: string; maxFileBytes: number; maxFiles: number };
}
/** Only an explicitly requested database handoff restarts locally; failures remain visible to the deployment manager. */
export async function runRestartableLoggedProcess(options: ManagedProcessOptions) {
  let stopped = 0;
  const interrupt = () => {
      stopped = 130;
    },
    terminate = () => {
      stopped = 143;
    };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    for (;;) {
      if (stopped) return stopped;
      const code = await runLoggedProcess({
        ...options,
        env: { ...(options.env ?? process.env), PANDA_FORCE_MANAGED_RESTART: "1" },
      });
      if (stopped) return code === 75 ? stopped : code;
      if (code !== 75) return code;
    }
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}
