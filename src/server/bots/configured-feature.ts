import { createBotFeature } from "./feature.js";
import { openBotDatabase } from "./database.js";

export async function createConfiguredBotFeature(options: Parameters<typeof createBotFeature>[0]) {
  const database = await openBotDatabase(options.stateRoot);
  try {
    const feature = createBotFeature({ ...options, ...(database.store ? { store: database.store } : {}) });
    return {
      ...feature,
      storageSummary: database.summary,
      async close() {
        try {
          await feature.close();
        } finally {
          await database.close();
        }
      },
    };
  } catch (error) {
    await database.close();
    throw error;
  }
}
