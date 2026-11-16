import { createHash } from "node:crypto";
import { stableJson } from "../../../shared/stable-json.js";
import {
  EDITORIAL_MODEL_OUTPUT_SCHEMA,
  EditorialModelOutputError,
  type EditorialModel,
  type EditorialModelInput,
  type EditorialModelRun,
} from "../model/contracts.js";
import { MODEL_EDITORIAL_LIMITS } from "../model/exchange.js";
import { editorialInstructions, EDITORIAL_PROMPT_VERSION } from "../model/instructions.js";

export interface ResponsesEditorialOptions {
  id: string;
  model: string;
  endpoint: string;
  credential: () => Promise<string | null>;
  credentialBinding?: string;
}
/** A single stateless, tool-free request. It has no coding-session, filesystem or publication capability. */
export class ResponsesEditorialModel implements EditorialModel {
  readonly profile;
  constructor(
    private options: ResponsesEditorialOptions,
    private send: typeof fetch = fetch,
  ) {
    this.profile = Object.freeze({
      id: options.id,
      engine: "responses",
      model: options.model,
      version: createHash("sha256")
        .update(
          stableJson({
            endpoint: options.endpoint,
            model: options.model,
            prompt: EDITORIAL_PROMPT_VERSION,
            schema: EDITORIAL_MODEL_OUTPUT_SCHEMA,
            credentialBinding: options.credentialBinding || "explicit-adapter",
          }),
        )
        .digest("hex"),
    });
  }
  async process(input: EditorialModelInput, run: EditorialModelRun): Promise<string> {
    run.signal.throwIfAborted();
    const key = await this.options.credential();
    run.signal.throwIfAborted();
    let response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      response = await this.send(this.options.endpoint, {
        method: "POST",
        redirect: "error",
        signal: run.signal,
        headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({
          model: this.options.model,
          store: false,
          stream: false,
          tools: [],
          tool_choice: "none",
          instructions: editorialInstructions(input.mode),
          input: [
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: JSON.stringify({
                    mode: input.mode,
                    segments: input.segments.map(({ id, text }) => ({ segmentId: id, text })),
                  }),
                },
              ],
            },
          ],
          text: {
            format: {
              type: "json_schema",
              name: "editorial_review",
              strict: true,
              schema: EDITORIAL_MODEL_OUTPUT_SCHEMA,
            },
          },
        }),
      });
      if (!response.ok) throw new Error("Editorial processor request failed");
      if (!response.headers.get("content-type")?.toLowerCase().includes("application/json") || !response.body)
        throw new EditorialModelOutputError("invalidOutput");
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.length;
        if (bytes > MODEL_EDITORIAL_LIMITS.outputBytes * 2) throw new EditorialModelOutputError("invalidOutput");
        chunks.push(part.value);
      }
      let payload: unknown;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new EditorialModelOutputError("invalidOutput");
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload))
        throw new EditorialModelOutputError("invalidOutput");
      const result = payload as Record<string, unknown>;
      if (result.status !== "completed" || !Array.isArray(result.output))
        throw new EditorialModelOutputError("invalidOutput");
      const text: string[] = [];
      for (const item of result.output) {
        if (!item || typeof item !== "object") throw new EditorialModelOutputError("invalidOutput");
        if (item.type === "reasoning") continue;
        if (item.type !== "message" || item.role !== "assistant" || !Array.isArray(item.content))
          throw new EditorialModelOutputError("invalidOutput");
        for (const part of item.content) {
          if (!part || part.type !== "output_text" || typeof part.text !== "string")
            throw new EditorialModelOutputError("invalidOutput");
          text.push(part.text);
        }
      }
      const output = text.join("");
      if (!output || Buffer.byteLength(output) > MODEL_EDITORIAL_LIMITS.outputBytes)
        throw new EditorialModelOutputError("invalidOutput");
      return output;
    } finally {
      void reader?.cancel().catch(() => {});
      if (!reader) void response?.body?.cancel().catch(() => {});
    }
  }
}
