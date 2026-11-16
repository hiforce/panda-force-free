import { runDatabaseRecoveryCommand } from "../../src/server/database/recover.js";

await runDatabaseRecoveryCommand(process.argv.slice(2));
