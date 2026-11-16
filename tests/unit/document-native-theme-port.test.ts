import { expect, test } from "bun:test";
import { MySQLDocumentService } from "../../src/server/documents/mysql-service.js";
import { ThemeSelectionError } from "../../src/shared/presentation/themes.js";
import { DocumentError } from "../../src/server/documents/errors.js";

test("native document theme validation awaits metadata and preserves the owned error before any mutation", async () => {
  let writes = 0,
    authorized = 0;
  const spaces = {
      get: async () => ({ projectId: "project", engine: "hexo" }),
      setTheme: async () => {
        writes++;
      },
    },
    themes = {
      list: async () => [],
      validate: async () => {
        throw new ThemeSelectionError("unknownTheme");
      },
      resolve: async () => {
        throw new ThemeSelectionError("unknownTheme");
      },
    };
  const service = new MySQLDocumentService(
    spaces as unknown as ConstructorParameters<typeof MySQLDocumentService>[0],
    {} as ConstructorParameters<typeof MySQLDocumentService>[1],
    {} as ConstructorParameters<typeof MySQLDocumentService>[2],
    "/unused",
    async () => {
      authorized++;
    },
    {} as ConstructorParameters<typeof MySQLDocumentService>[5],
    themes,
  );
  await expect(service.updateTheme("space", { theme: "missing", version: 1 })).rejects.toBeInstanceOf(DocumentError);
  await expect(service.updateTheme("space", { theme: "missing", version: 1 })).rejects.toMatchObject({
    code: "unknownTheme",
  });
  expect(writes).toBe(0);
  expect(authorized).toBe(2);
});
