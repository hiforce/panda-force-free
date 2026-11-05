import { expect, test } from "bun:test";
import { Readable } from "node:stream";
import { readJsonBody, RequestBodyError } from "../../src/server/http/body.js";
const request = (chunks: string[]) => Readable.from(chunks) as any;
test("JSON object bodies reject primitives, null, arrays, syntax errors and oversized UTF-8", async () => {
  expect(await readJsonBody(request(['{"text":"', "你好", '"}']))).toEqual({ text: "你好" });
  for (const value of ["null", "[]", "1", '"text"', "{"]) {
    try {
      await readJsonBody(request([value]));
      throw new Error("Expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(RequestBodyError);
      expect((error as RequestBodyError).status).toBe(400);
    }
  }
  try {
    await readJsonBody(request(['{"x":"', "你好", '"}']), 10);
    throw new Error("Expected rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(RequestBodyError);
    expect((error as RequestBodyError).status).toBe(413);
  }
});
