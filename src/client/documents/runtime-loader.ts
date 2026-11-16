export type RuntimeEntry = 0 | 1;
class RuntimeWaitTimeout extends Error {}
export class RuntimeLoadError extends Error {
  constructor(
    readonly phase: "transfer" | "initialization",
    readonly retryable: boolean,
    cause: unknown,
  ) {
    super("Document runtime " + phase + " failed", { cause });
  }
}

/** Downloads may recover in place; a partially evaluated runtime must never execute again. */
export class DocumentRuntimeLoader<T> {
  private transfer: Promise<RuntimeEntry> | null = null;
  private runtime: Promise<T> | null = null;
  private evaluation: Promise<T> | null = null;
  private entry: RuntimeEntry = 0;
  private failure: RuntimeLoadError | null = null;
  constructor(
    private readonly port: {
      prime(entry: RuntimeEntry): Promise<void>;
      evaluate(entry: RuntimeEntry): Promise<T>;
      evaluationTimeoutMs?: number;
      isTransferFailure?(cause: unknown): boolean;
    },
  ) {}
  warm() {
    if (this.transfer) return this.transfer;
    if (this.failure?.phase === "initialization") return Promise.reject(this.failure);
    const entry = this.entry;
    const pending = Promise.resolve()
      .then(() => this.port.prime(entry))
      .then(() => {
        this.failure = null;
        return entry;
      })
      .catch((cause) => {
        this.transfer = null;
        this.entry = 1;
        this.failure = new RuntimeLoadError("transfer", true, cause);
        throw this.failure;
      });
    this.transfer = pending;
    return pending;
  }
  load() {
    if (this.runtime) return this.runtime;
    const pending = this.warm()
      .then(async (entry) => {
        try {
          this.evaluation ||= Promise.resolve().then(() => this.port.evaluate(entry));
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            return await Promise.race([
              this.evaluation,
              new Promise<T>((_, reject) => {
                timer = setTimeout(() => reject(new RuntimeWaitTimeout()), this.port.evaluationTimeoutMs ?? 20000);
              }),
            ]);
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
        } catch (cause) {
          if (entry === 0 && this.port.isTransferFailure?.(cause)) {
            this.transfer = null;
            this.evaluation = null;
            this.entry = 1;
            this.failure = new RuntimeLoadError("transfer", true, cause);
            throw this.failure;
          }
          this.failure = new RuntimeLoadError("initialization", cause instanceof RuntimeWaitTimeout, cause);
          throw this.failure;
        }
      })
      .catch((error) => {
        if (error instanceof RuntimeLoadError && error.retryable) this.runtime = null;
        throw error;
      });
    this.runtime = pending;
    return pending;
  }
}
