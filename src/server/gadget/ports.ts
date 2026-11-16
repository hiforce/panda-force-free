import type { GadgetLayout } from "../../shared/gadget/contracts.js";
export interface GadgetRepository {
  read(owner: string): GadgetLayout | Promise<GadgetLayout>;
  replay(owner: string, id: string, request: string): GadgetLayout | null | Promise<GadgetLayout | null>;
  save(
    owner: string,
    id: string,
    request: string,
    expected: number,
    next: GadgetLayout,
  ): GadgetLayout | Promise<GadgetLayout>;
  close(): void | Promise<void>;
}
