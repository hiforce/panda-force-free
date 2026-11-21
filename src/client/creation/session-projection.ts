import type { CreationTaskDetail } from "../../shared/creation/contracts.js";
import { creationProgressText } from "../../shared/creation/progress.js";
import type { EngineItem } from "../../shared/engine/types.js";
import type { Translate } from "../../shared/i18n/messages.js";
import { sessionSkillContext } from "../../shared/session-skills.js";
import { buildComposerInput } from "../composer-attachments.js";
import { creationActive } from "./activity.js";

/** Stable activity identities and private-answer redaction are independent of the DOM. */
export function creationRoundItems(round: CreationTaskDetail, t: Translate) {
  const turn = "creation-" + round.id;
  const requestContent = buildComposerInput(round.prompt, round.attachments || []);
  requestContent.push({
    type: "text",
    text: sessionSkillContext(
      round.skillSummaries || (round.selections || []).map((selection) => ({ selection, name: { en: selection.id } })),
      "",
    ),
  });
  const request: EngineItem = {
    id: turn + "-request",
    type: "userMessage",
    content: requestContent,
    sentAt: round.createdAt / 1000,
  };
  const entries: Array<{ at: number; item: EngineItem }> = round.progress.flatMap((entry, index) => {
    const text = entry.stage === "message" ? entry.text : creationProgressText(entry, t, creationActive(round));
    return text
      ? [
          {
            at: entry.at,
            item: {
              id: turn + "-" + (entry.id || index),
              type: "agentMessage",
              text,
              ...(entry.stage !== "message" ? { phase: "commentary" } : {}),
              status: entry.streaming && creationActive(round) ? "inProgress" : "completed",
              receivedAt: entry.at / 1000,
            },
          },
        ]
      : [];
  });
  for (const message of round.messages || []) {
    const content = buildComposerInput(message.text, message.attachments);
    content.push({
      type: "text",
      text: sessionSkillContext(
        message.skillSummaries || message.selections.map((selection) => ({ selection, name: { en: selection.id } })),
        "",
      ),
    });
    entries.push({
      at: message.createdAt,
      item: {
        id: turn + "-update-" + message.id,
        type: "userMessage",
        content,
        steer: true,
        delivery:
          message.state === "uncertain"
            ? "unconfirmed"
            : message.state === "received"
              ? "creation-received"
              : message.state === "dispatching"
                ? "creation-delivering"
                : "sent",
        sentAt: message.createdAt / 1000,
      },
    });
  }
  for (const [index, clarification] of round.clarifications.entries()) {
    entries.push({
      at: clarification.askedAt || round.createdAt,
      item: {
        id: turn + "-question-" + index,
        type: "agentMessage",
        text: clarification.questions.map((question) => question.question).join("\n\n"),
      },
    });
    if (clarification.answeredAt)
      entries.push({
        at: clarification.answeredAt,
        item: {
          id: turn + "-answer-" + index,
          type: "userMessage",
          steer: true,
          content: [
            {
              type: "text",
              text: clarification.questions
                .map((question) =>
                  question.isSecret
                    ? t("creation.privateAnswer")
                    : (clarification.answers[question.id]?.answers || []).join("\n"),
                )
                .join("\n\n"),
            },
          ],
        },
      });
  }
  entries.sort((a, b) => a.at - b.at);
  return { turn, request, entries };
}
