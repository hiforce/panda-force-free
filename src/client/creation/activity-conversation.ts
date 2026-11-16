import type { CreationTaskDetail } from "../../shared/creation/contracts.js";
import type { Translate } from "../../shared/i18n/messages.js";
import { escapeHtml as e } from "../../shared/html.js";
import { documentPreview } from "../documents/preview.js";
import { messageHtml } from "../i18n.js";

/** Only saved user briefs, visible assistant messages and application questions become conversation content. */
export function creationConversation(rounds: readonly CreationTaskDetail[], t: Translate) {
  const bubble = (role: "user" | "assistant", text: string) =>
    `<article class="creation-message" data-conversation-role="${role}"><header>${messageHtml(role === "user" ? "creation.you" : "creation.assistant", {}, t)}</header><div>${role === "assistant" ? documentPreview(text) : e(text)}</div></article>`;
  return rounds
    .map((round, index) => {
      const entries: { role: "user" | "assistant"; text: string; at: number }[] = [];
      for (const event of round.progress)
        if (event.stage === "message" && event.text)
          entries.push({ role: "assistant", text: event.text, at: event.at });
      for (const entry of round.clarifications) {
        entries.push({
          role: "assistant",
          text: entry.questions.map((question) => question.question).join("\n\n"),
          at: entry.askedAt ?? Number.MAX_SAFE_INTEGER,
        });
        entries.push({
          role: "user",
          text: entry.questions
            .map((question) =>
              question.isSecret ? t("creation.privateAnswer") : (entry.answers[question.id]?.answers ?? []).join("\n"),
            )
            .join("\n\n"),
          at: entry.answeredAt ?? entry.askedAt ?? Number.MAX_SAFE_INTEGER,
        });
      }
      return `<section class="creation-conversation-round" data-conversation-round="${e(round.id)}"><p class="creation-round-label">${messageHtml(index === rounds.length - 1 ? "creation.currentRound" : "creation.previousRound", {}, t)}</p>${bubble("user", round.prompt)}${entries
        .toSorted((a, b) => a.at - b.at)
        .map((entry) => bubble(entry.role, entry.text))
        .join(
          "",
        )}${round.artifact && index !== rounds.length - 1 ? `<a class="creation-round-output" href="/documents?${new URLSearchParams({ project: round.projectId, document: round.artifact.documentId })}">${messageHtml("creation.openDocument", {}, t)}</a>` : ""}</section>`;
    })
    .join("");
}

export async function previousCreationRounds(
  current: CreationTaskDetail,
  read: (id: string) => Promise<{ task: CreationTaskDetail }>,
  cache: Map<string, { task: CreationTaskDetail; at: number }>,
) {
  const rounds = [current],
    seen = new Set([current.id]);
  let previous = current.previousTaskId;
  while (previous && rounds.length < 20 && !seen.has(previous)) {
    seen.add(previous);
    const stored = cache.get(previous);
    const task = stored && Date.now() - stored.at < 10000 ? stored.task : (await read(previous)).task;
    cache.set(previous, { task, at: Date.now() });
    rounds.unshift(task);
    previous = task.previousTaskId;
  }
  while (cache.size > 20) cache.delete(cache.keys().next().value!);
  return rounds;
}
