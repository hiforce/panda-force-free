export class TemplatePreviewError extends Error {
  constructor(
    readonly code: "invalidInput" | "notFound" | "unavailable" | "busy" | "conflict" | "disabled" | "unsupported",
    readonly status = code === "notFound"
      ? 404
      : code === "invalidInput"
        ? 400
        : code === "disabled"
          ? 403
          : code === "conflict"
            ? 409
            : code === "busy"
              ? 429
              : 503,
  ) {
    super(code);
  }
}
