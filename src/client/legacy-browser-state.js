// Move preferences and drafts once; never overwrite an explicit new preference.
export function migrateBrowserState(target) {
  try {
    target ||= globalThis.localStorage;
    const prefix = "codex-webui-";
    const keys = Array.from({ length: target.length }, (_, index) => target.key(index));
    for (const key of keys) {
      if (!key?.startsWith(prefix)) continue;
      const canonical = "panda-force-" + key.slice(prefix.length);
      const value = target.getItem(key);
      if (target.getItem(canonical) === null && value !== null) target.setItem(canonical, value);
      // Preserve the old value if quota/privacy restrictions prevented the copy.
      if (target.getItem(canonical) !== null) target.removeItem(key);
    }
  } catch {
    // Browsers that deny storage keep operating without persisted preferences.
  }
}
