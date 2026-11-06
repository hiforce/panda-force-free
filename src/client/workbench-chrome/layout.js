import { storage, STORAGE_KEYS } from "../storage.js";

/** Width is persistent; focus is temporary and never changes session preferences. */
/** @param {Pick<import('../contracts/workbench-chrome.js').WorkbenchChromeOptions, 'readSidebar' | 'setSidebar' | 'readDetails' | 'setDetails' | 'hasSession'>} options */
export function createWorkbenchLayout(options) {
  /** @type {{navigation: boolean; details: boolean} | null} */
  let beforeFocus = null;
  /** @param {string | null} value @returns {import('../contracts/workbench-chrome.js').ReadingWidth} */
  const normalized = (value) => (value === "wide" || value === "fill" ? value : "comfortable");
  function readWidth() {
    return normalized(document.documentElement.dataset.workbenchWidth || storage.get(STORAGE_KEYS.layout));
  }
  function setWidth(value) {
    const width = normalized(value);
    document.documentElement.dataset.workbenchWidth = width;
    storage.set(STORAGE_KEYS.layout, width);
  }
  function setFocus(focused) {
    if (focused === Boolean(beforeFocus)) return;
    if (focused) {
      beforeFocus = { navigation: options.readSidebar(), details: options.readDetails() };
      options.setSidebar(false, { temporary: true });
      options.setDetails(false, { temporary: true });
    } else if (beforeFocus) {
      const previous = beforeFocus;
      beforeFocus = null;
      options.setSidebar(previous.navigation, { temporary: true });
      if (options.hasSession()) options.setDetails(previous.details, { temporary: true });
    }
    document.body.classList.toggle("workbench-focus", Boolean(beforeFocus));
  }
  function setPanel(panel, open) {
    if (beforeFocus) setFocus(false);
    if (panel === "navigation") options.setSidebar(open);
    else options.setDetails(open);
  }
  function reconcileViewport() {
    if (!beforeFocus || matchMedia("(min-width: 768px)").matches) return;
    // Desktop panel preferences must never open modal drawers during a resize to H5.
    beforeFocus = null;
    document.body.classList.remove("workbench-focus");
    options.setSidebar(false, { temporary: true });
    options.setDetails(false, { temporary: true });
  }
  document.documentElement.dataset.workbenchWidth = normalized(storage.get(STORAGE_KEYS.layout));
  return { readWidth, setWidth, isFocused: () => Boolean(beforeFocus), setFocus, setPanel, reconcileViewport };
}
