import type { WorkflowStep, WorkflowResolution, WorkflowRecord } from "./workflow.js";

export function resolvedWorkflowSteps(steps: WorkflowStep[], resolutions: WorkflowResolution[]): WorkflowStep[] {
  const byStep = new Map(resolutions.map((item) => [item.stepId, item]));
  return steps.map((step) => {
    const resolution = byStep.get(step.id);
    return step.outcome === "pending" && resolution
      ? { ...step, outcome: "succeeded", result: resolution.result, error: null, completedAt: resolution.decidedAt }
      : step;
  });
}

/** Runtime consumers see confirmed ancestor references plus this plan's own resolution overlay. */
export function executionWorkflowSteps(record: WorkflowRecord): WorkflowStep[] {
  return [...(record.lineage?.steps || []), ...resolvedWorkflowSteps(record.steps, record.resolutions || [])];
}
