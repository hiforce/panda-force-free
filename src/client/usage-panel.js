import { codexRateLimits, renderQuotaWindows } from "./account-usage.js";
import { setOpaqueText } from "./i18n.js";
import { createLatestRequestGate } from "./ui-core.js";

const USAGE_REFRESH_MS = 60000;

/**
 * Account usage (quota) panel: load/refresh scheduling, rendering and the
 * push-updated path. Owns the usage request gate and timer.
 */
export function createUsagePanel({ $, t, i18n, state, rpc }) {
  const usageRequestGate = createLatestRequestGate();
  let usageLimits = null,
    usageLoading = false,
    usageError = "",
    usageUpdatedAt = null,
    usageTimer = null;

  function usagePageVisible() {
    return !$("#summaryPanel").hidden;
  }
  function renderUsage() {
    renderQuotaWindows($("#usageWindows"), usageLimits, { t, locale: i18n.locale });
    $("#refreshUsage").disabled = usageLoading || !state.connected;
    setOpaqueText(
      $("#usageStatus"),
      usageLoading
        ? t("usage.loadingUsage")
        : usageError
          ? t(usageError)
          : usageUpdatedAt
            ? `${t("usage.updatedAt")}: ${new Intl.DateTimeFormat(i18n.locale, { timeStyle: "short" }).format(usageUpdatedAt)}`
            : "",
    );
  }
  function scheduleUsageRefresh() {
    clearTimeout(usageTimer);
    if (usagePageVisible() && document.visibilityState === "visible")
      usageTimer = setTimeout(() => loadUsage(), USAGE_REFRESH_MS);
  }
  async function loadUsage() {
    if (usageLoading) return;
    if (!state.connected) {
      usageError = "common.connectToCodexToLoadUsage";
      renderUsage();
      return;
    }
    const requestId = usageRequestGate.next();
    usageLoading = true;
    usageError = "";
    renderUsage();
    try {
      const result = await rpc("account/rateLimits/read", {});
      if (!usageRequestGate.isCurrent(requestId)) return;
      usageLimits = codexRateLimits(result);
      usageUpdatedAt = new Date();
      if (!usageLimits) usageError = "common.noCodexQuotaDataChatgptSignInIsRequired";
    } catch {
      if (usageRequestGate.isCurrent(requestId)) usageError = "errors.unableToLoadUsageCheckCodexSignInAndRetry";
    } finally {
      if (usageRequestGate.isCurrent(requestId)) {
        usageLoading = false;
        renderUsage();
        scheduleUsageRefresh();
      }
    }
  }
  function resetUsage() {
    usageRequestGate.next();
    clearTimeout(usageTimer);
    usageLimits = null;
    usageLoading = false;
    usageUpdatedAt = null;
    usageError = "";
    renderUsage();
  }
  /** Bridge disconnected: clear data and show the reconnect hint. */
  function showDisconnected() {
    resetUsage();
    usageError = "common.connectToCodexToLoadUsage";
    renderUsage();
  }
  /** account/rateLimits/updated push: adopt the limits without a round-trip. */
  function applyPushedLimits(payload) {
    const limits = codexRateLimits(payload);
    if (!limits) return;
    usageRequestGate.next();
    usageLoading = false;
    usageLimits = limits;
    usageError = "";
    usageUpdatedAt = new Date();
    renderUsage();
    scheduleUsageRefresh();
  }
  function pauseRefresh() {
    clearTimeout(usageTimer);
  }

  return {
    usagePageVisible,
    renderUsage,
    scheduleUsageRefresh,
    loadUsage,
    resetUsage,
    showDisconnected,
    applyPushedLimits,
    pauseRefresh,
  };
}
