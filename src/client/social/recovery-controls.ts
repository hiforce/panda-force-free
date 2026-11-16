import type { WorkflowRecord } from "../../shared/delivery/workflow.js";
import { socialApi } from "./api.js";

/** Recovery controls never submit the remaining publication steps. */
export function recoveryDisabled(action: string, button: HTMLButtonElement) {
  const root = button.closest<HTMLElement>("[data-recovery-step]");
  if (action === "recovery-inspect")
    return (
      !root?.querySelector<HTMLInputElement>("[data-recovery-costs]")?.checked ||
      !/^[0-9]{1,19}$/.test(root?.querySelector<HTMLInputElement>("[data-recovery-id]")?.value || "")
    );
  if (action === "recovery-adopt") return !root?.querySelector<HTMLInputElement>("[data-recovery-accept]")?.checked;
  return false;
}
export async function recoveryAction(action: string, button: HTMLButtonElement, record: WorkflowRecord) {
  if (recoveryDisabled(action, button)) return;
  const root = button.closest<HTMLElement>("[data-recovery-step]");
  if (action === "recovery-inspect" && root)
    await socialApi.inspect(
      record,
      Number(root.dataset.recoveryStep),
      root.querySelector<HTMLInputElement>("[data-recovery-id]")!.value,
    );
  if (action === "recovery-adopt" && root) await socialApi.adopt(record, button.dataset.evidence!);
}
