import type { LocalConnectionInput, PublicationRoot } from "../../shared/connections/contracts.js";

/** Target selection is independent of deployment and never exposes a shell command. */
export interface LocalTargetPolicy {
  roots(): PublicationRoot[];
  resolve(input: Pick<LocalConnectionInput, "root" | "directory">): string;
  inspect(target: string, connectionId: string): Promise<void>;
  test(target: string, connectionId: string): Promise<void>;
}
