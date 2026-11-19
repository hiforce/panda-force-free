/** Follow the public composer entry instead of controls that belong to the inspector. */
export async function openComposerSettings(page, kind) {
  await page.locator("#composerSettingsButton").click();
  await page.locator(`[data-composer-setting="${kind}"]`).click();
}

export async function selectSessionModel(page, model) {
  const choice = page.locator(`[data-settings-model="${model}"]`);
  if (await choice.count()) await choice.click();
  else await page.locator("#sessionSettingModel").selectOption(model);
}

export async function selectedSessionModel(page) {
  const choice = page.locator('[data-settings-model][aria-pressed="true"]');
  return (await choice.count())
    ? choice.getAttribute("data-settings-model")
    : page.locator("#sessionSettingModel").inputValue();
}
