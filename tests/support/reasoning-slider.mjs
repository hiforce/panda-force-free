import assert from "node:assert/strict";

export const reasoningSteps = (field) =>
  field
    .locator("..")
    .locator("[data-effort]")
    .evaluateAll((ticks) => ticks.map((tick) => tick.dataset.effort));

export async function chooseReasoning(field, value) {
  const slider = field.locator("..").getByRole("slider");
  await slider.waitFor();
  const steps = await reasoningSteps(field);
  const position = steps.indexOf(value);
  assert(position >= 0, `Missing reasoning step ${value}: ${steps.join(", ")}`);
  await slider.press("Home");
  for (let step = 0; step < position; step++) await slider.press("ArrowRight");
  assert.equal(await field.inputValue(), value);
}
