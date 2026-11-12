import { findElement, requireElement } from "./dom.js";
import { localizeText, messageHtml, setMessageHtml, setOpaqueText } from "./i18n.js";
import { activityText } from "../shared/activity-text.js";
import { parseUnifiedDiff, summarizeActivity, unifiedDiffFromFileChanges } from "../shared/codex-surfaces.js";
import { codexIcon } from "./codex-icons.js";
import { renderDiffLine } from "./diff-rendering.js";
import { renderAssistantMarkdown, renderItemImages } from "./rendering.js";
import { setConversationContent } from "./conversation-renderers/content.js";

// Output bodies are independent of activity grouping, expansion and session state.
function joinActivityText(value) {
  return activityText(value);
}
export function activityOutput(item) {
  if (item.type === "reasoning") return joinActivityText(item.summary) || joinActivityText(item.content);
  const output = item.aggregatedOutput ?? item.output?.aggregatedOutput ?? item.output;
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return output.join("\n");
  return joinActivityText(item.content) || (item.result ? JSON.stringify(item.result, null, 2) : "");
}
export function commandText(item) {
  return (
    item.command ||
    (item.commandActions || [])
      .map((action) => action?.command)
      .filter(Boolean)
      .join("\n") ||
    ""
  );
}
export function isExplorationActivity(item, data = summarizeActivity(item)) {
  return item.type === "commandExecution" && ["read", "search", "list"].includes(data.category || "");
}

export function createActivityOutputRenderer({ escapeHtml, shortPath, imageCwd }) {
  const reviewLineHtml = (line) => renderDiffLine(line, escapeHtml);
  const icons = { check: codexIcon("check") };
  function commandExitCode(item) {
    return item.exitCode ?? item.output?.exitCode;
  }
  function commandFooter(item, data) {
    if (data.active) return { label: "", icon: "" };
    if (item.executionStatus === "interrupted" || item.status === "interrupted" || item.status === "cancelled")
      return { label: "sessions.stopped", icon: "" };
    const exitCode = commandExitCode(item);
    if (data.tone === "error")
      return {
        label: exitCode == null ? "common.failed" : "common.exitCode",
        values: { code: exitCode },
        icon: "",
      };
    return { label: "common.success", icon: icons.check };
  }
  function renderCommandShell(out, item, data) {
    if (out.dataset.outputKind !== "command") {
      out.dataset.outputKind = "command";
      out.className = "activity-output command-shell-wrap";
      setMessageHtml(
        out,
        '<div class="command-shell"><div class="command-shell-body"><div class="command-shell-command"><span aria-hidden="true">$</span><code></code></div><div class="command-shell-output"><pre></pre></div></div><div class="command-shell-footer"></div></div>',
      );
    }
    const output = activityOutput(item),
      pre = requireElement(".command-shell-output pre", out),
      footer = commandFooter(item, data);
    setOpaqueText(findElement(".command-shell-command code", out), commandText(item));
    if (output || data.active) setOpaqueText(pre, output);
    else localizeText(pre, "common.noOutput");
    pre.classList.toggle("empty", !output);
    setMessageHtml(
      findElement(".command-shell-footer", out),
      `${footer.icon}${footer.label ? messageHtml(footer.label, footer.values) : ""}`,
    );
  }
  function inlineFileChangeDiff(change) {
    const raw = unifiedDiffFromFileChanges([change]),
      review = parseUnifiedDiff(raw);
    if (!review.hasChanges) {
      const diff = change.diff || change.unified_diff || "";
      return diff ? `<pre>${escapeHtml(diff)}</pre>` : "";
    }
    return `<div class="file-change-inline-diff">${review.files.flatMap((file) => file.hunks.map((hunk) => `<div class="file-change-inline-hunk"><div class="review-hunk-head">${escapeHtml(hunk.header)}</div><div class="review-lines">${hunk.lines.map(reviewLineHtml).join("")}</div></div>`)).join("")}</div>`;
  }
  function renderFileChangeOutput(out, item, data) {
    out.dataset.outputKind = "file-change";
    out.className = "activity-output file-change-output";
    const changes = item.changes || [],
      legacy = activityOutput(item);
    if (!changes.length) {
      setMessageHtml(
        out,
        `<div class="file-change-progress ${data.active ? "loading-shimmer" : ""}">${legacy ? escapeHtml(legacy) : messageHtml(data.active ? "common.waitingPatch" : "common.noPatchDetails")}</div>`,
      );
      return;
    }
    setMessageHtml(
      out,
      changes
        .map((change) => {
          const path = change.path || change.filePath || "Changed file",
            kind = typeof change.kind === "string" ? change.kind : change.kind?.type || "update";
          return `<section class="file-change-output-item"><div class="file-change-output-head">${codexIcon("fileDiff")}<span>${escapeHtml(shortPath(path))}</span><small>${escapeHtml(kind)}</small></div>${inlineFileChangeDiff(change)}</section>`;
        })
        .join(""),
    );
  }
  function renderActivityOutput(out, item, data) {
    if (item.type === "imageView") {
      out.dataset.outputKind = "image";
      out.className = "activity-output activity-image-output";
      setConversationContent(
        out,
        renderItemImages(item, {
          cwd: imageCwd(item),
          className: "activity-image-grid",
          thumbnail: true,
        }) ||
          '<div class="message-image-unavailable" data-i18n-ui><span data-pf-message="common.imageUnavailable">Image unavailable</span></div>',
      );
      return;
    }
    if (item.type === "commandExecution" && data.category === "command") {
      renderCommandShell(out, item, data);
      return;
    }
    if (item.type === "fileChange") {
      renderFileChangeOutput(out, item, data);
      return;
    }
    if (item.type === "reasoning") {
      const text = activityOutput(item);
      out.dataset.outputKind = "reasoning";
      out.className = "activity-output reasoning-output message-text";
      setMessageHtml(out, text ? renderAssistantMarkdown(text, { cwd: imageCwd(item) }) : "");
      return;
    }
    out.dataset.outputKind = "plain";
    out.className = "activity-output";
    setOpaqueText(out, isExplorationActivity(item, data) ? "" : activityOutput(item) || "");
  }
  return renderActivityOutput;
}
