/** The model tool and external CLI publish the same closed draft-input schema. */
export function knowledgeDraftSchema() {
  const evidenceSchema = {
    type: "object",
    additionalProperties: false,
    required: ["sourceId", "version", "quote"],
    properties: {
      sourceId: { type: "string", maxLength: 128 },
      version: { type: "string", maxLength: 160 },
      quote: { type: "string", maxLength: 4000 },
      start: { type: "integer", minimum: 0 },
      section: { type: "string", maxLength: 160 },
    },
  };
  return {
    type: "object",
    additionalProperties: false,
    required: ["schema", "title", "summary", "claims", "uncertainties"],
    properties: {
      schema: { type: "integer", enum: [1] },
      title: { type: "string", maxLength: 300 },
      summary: { type: "string", maxLength: 16000 },
      claims: {
        type: "array",
        minItems: 1,
        maxItems: 64,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "kind", "text", "evidence"],
          properties: {
            id: { type: "string", maxLength: 128 },
            kind: { type: "string", enum: ["source", "inference", "user"] },
            text: { type: "string", maxLength: 8000 },
            evidence: { type: "array", maxItems: 16, items: evidenceSchema },
          },
        },
      },
      uncertainties: { type: "array", maxItems: 32, items: { type: "string", maxLength: 2000 } },
    },
  };
}
