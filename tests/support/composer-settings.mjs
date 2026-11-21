/** Follow the public composer entry instead of controls that belong to the inspector. */
export async function fillComposer(page, text) {
  const input = page.locator("#prompt");
  await page.locator("#composer").waitFor({ state: "visible" });
  if (!(await input.isVisible())) await page.locator(".message-composer-disclosure").click();
  await input.fill(text);
}

export async function openComposerSettings(page, kind) {
  await page.locator("#composerSettingsButton").click();
  await page.locator(`[data-composer-setting="${kind}"]`).click();
}

export async function selectSessionModel(page, model) {
  const choice = page.locator(`[data-settings-model="${model}"]`);
  if (await choice.count()) await choice.click();
  else if (await page.locator('[name="session-runtime-model"]').count())
    await page.locator('[name="session-runtime-model"]').selectOption(model);
  else await page.locator("#sessionSettingModel").selectOption(model);
}

export async function selectedSessionModel(page) {
  const choice = page.locator('[data-settings-model][aria-pressed="true"]');
  if (await page.locator('[name="session-runtime-model"]').count())
    return page.locator('[name="session-runtime-model"]').inputValue();
  return (await choice.count())
    ? choice.getAttribute("data-settings-model")
    : page.locator("#sessionSettingModel").inputValue();
}

export async function selectSessionEffort(page, effort) {
  const field = page.locator('[name="session-runtime-effort"]');
  if (await field.count()) await field.selectOption(effort);
  else {
    const slider = page.locator('#sessionSettingEfforts input[type="range"]');
    const end = effort === "high" || effort === "xhigh";
    await slider.press(end ? "End" : "Home");
  }
}
