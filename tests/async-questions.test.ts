import { createI18nRuntime } from "../src/shared/i18n/runtime.js";
const english = createI18nRuntime().t;
import { expect, test, afterEach } from "bun:test";
import { JSDOM } from "jsdom";
import {
  readAsyncQuestions,
  createAsyncQuestionCard,
  closeEarlierAsyncQuestions,
} from "../src/client/async-questions.js";
import { parseRollout } from "../src/server/bridge/live-session.js";
const previous = globalThis.document;
let dom: JSDOM;
afterEach(() => {
  dom?.window.close();
  globalThis.document = previous;
});
test("host function calls survive rollout parsing as interactive questions", () => {
  const argumentsText = JSON.stringify({
    questions: [{ title: "Choose a test", options: ["Options", "Custom answer"] }],
  });
  for (const name of ["request_user_input_async", "functions.request_user_input_async"]) {
    const events = [
      { type: "event_msg", payload: { type: "task_started", turn_id: "questions" } },
      {
        type: "response_item",
        payload: { type: "function_call", call_id: "question-call", name, arguments: argumentsText },
      },
      {
        type: "response_item",
        payload: { type: "function_call", call_id: "ordinary-call", name: "unrelated_tool", arguments: argumentsText },
      },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "questions" } },
    ];
    const state = parseRollout(events.map((event) => JSON.stringify(event)).join("\n"));
    expect(state.turn.items).toHaveLength(1);
    expect(state.turn.items[0].id).toBe("question-call");
    expect(readAsyncQuestions(state.turn.items[0])?.[0].question).toBe("Choose a test");
  }
});
test("async tools normalize their own questions without treating ordinary tool output as a request", () => {
  const item = {
    type: "dynamicToolCall",
    tool: "functions.request_user_input_async",
    arguments: JSON.stringify({ questions: [{ title: "Select a repository", options: ["Public", "Private"] }] }),
  };
  expect(readAsyncQuestions(item)?.[0].options).toEqual([{ label: "Public" }, { label: "Private" }]);
  for (const bad of [
    { ...item, tool: "other_tool" },
    { ...item, arguments: "{" },
    { ...item, arguments: { questions: [null] } },
    { ...item, arguments: { questions: [{ title: "Question", options: {} }] } },
  ])
    expect(readAsyncQuestions(bad)).toBeNull();
});
test("answer submission is explicit, failed submission remains retryable and successful cards stay resolved", async () => {
  dom = new JSDOM("<body></body>");
  globalThis.document = dom.window.document;
  const item = {
    id: "async",
    type: "mcpToolCall",
    tool: "request_user_input_async",
    arguments: { questions: [{ title: "Where?", options: ["Public", "Private"] }] },
  };
  let fail = true,
    prepared = "";
  const card = createAsyncQuestionCard(item, readAsyncQuestions(item), {
    t: english,
    sendAnswer: async (text: string) => {
      if (fail) throw Error("Synthetic failure");
      prepared = text;
    },
  });
  document.body.append(card);
  const radio = card.querySelector("input")!;
  radio.checked = true;
  radio.dispatchEvent(new dom.window.Event("change"));
  const submit = () => card.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  submit();
  await new Promise((r) => setTimeout(r, 0));
  expect(card.querySelector<HTMLButtonElement>("[type=submit]")!.disabled).toBe(false);
  expect(card.open).toBe(true);
  fail = false;
  submit();
  await new Promise((r) => setTimeout(r, 0));
  expect(prepared).toBe("Where?\nPublic");
  expect(card.open).toBe(false);
  expect(card.dataset.status).toBe("submitted");
  closeEarlierAsyncQuestions(document.body, (s: string) => s);
  expect(card.dataset.status).toBe("submitted");
  expect(card.querySelector<HTMLFieldSetElement>("fieldset")!.disabled).toBe(true);
  expect(card.querySelector<HTMLButtonElement>("[type=submit]")!.hidden).toBe(true);
});

test("uncertain delivery does not offer a second send", async () => {
  dom = new JSDOM("<body></body>");
  globalThis.document = dom.window.document;
  const item = {
    id: "uncertain",
    type: "dynamicToolCall",
    tool: "request_user_input_async",
    arguments: { questions: [{ title: "Where?", options: ["Public"] }] },
  };
  const card = createAsyncQuestionCard(item, readAsyncQuestions(item), {
    t: english,
    sendAnswer: async () => ({ deliveryUncertain: true }),
  });
  document.body.append(card);
  const radio = card.querySelector("input")!;
  radio.checked = true;
  radio.dispatchEvent(new dom.window.Event("change"));
  card.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  await new Promise((r) => setTimeout(r, 0));
  expect(card.dataset.status).toBe("unconfirmed");
  expect(card.querySelector("summary")!.textContent).toBe("Delivery unconfirmed");
  expect(card.querySelector<HTMLButtonElement>("[type=submit]")!.hidden).toBe(true);
});

test("same-turn and later-turn user replies retire host questions without resolving newer prompts", () => {
  const start = (id: string) => ({ type: "event_msg", payload: { type: "task_started", turn_id: id } });
  const user = (message: string) => ({ type: "event_msg", payload: { type: "user_message", message } });
  const question = (id: string) => ({
    type: "response_item",
    payload: {
      type: "function_call",
      call_id: id,
      name: "request_user_input_async",
      arguments: JSON.stringify({ questions: [{ title: "Choose " + id, options: ["A", "B"] }] }),
    },
  });
  const events = [
    start("same-turn"),
    user("Opening prompt"),
    question("old-question"),
    {
      type: "response_item",
      payload: { type: "function_call_output", call_id: "old-question", output: '{"accepted":true}' },
    },
  ];
  const pending = parseRollout(events.map((event) => JSON.stringify(event)).join("\n"));
  expect(pending.questionTurns.get("same-turn").items[0].questionState).toBeUndefined();
  events.push(user("Choose old-question\nA"), question("new-question"));
  const replied = parseRollout(events.map((event) => JSON.stringify(event)).join("\n"));
  expect(replied.questionTurns.get("same-turn").items[0].questionState).toBe("earlier");
  expect(replied.questionTurns.get("same-turn").items[1].questionState).toBeUndefined();
  expect(replied.turn.items.find((item) => item.id === "old-question").questionState).toBe("earlier");
  events.push(
    { type: "event_msg", payload: { type: "task_complete", turn_id: "same-turn" } },
    start("later-turn"),
    user("Continue the conversation"),
  );
  const later = parseRollout(events.map((event) => JSON.stringify(event)).join("\n"));
  expect(later.questionTurns.get("same-turn").items.every((item) => item.questionState === "earlier")).toBe(true);
});

test("answered host supplements stay before their reply and restore as collapsed history", async () => {
  const { mergeConversationHistory } = await import("../src/client/ui-core.js");
  dom = new JSDOM("<body></body>");
  globalThis.document = dom.window.document;
  const question = {
    id: "answered-question",
    type: "dynamicToolCall",
    tool: "request_user_input_async",
    arguments: { questions: [{ title: "Which address?", options: ["example.com"] }] },
    questionState: "earlier",
    questionUserSequence: 1,
  };
  const response = {
    thread: { id: "thread" },
    history: {
      mode: "snapshot",
      turns: [
        {
          id: "turn",
          status: "completed",
          items: [
            { id: "opening", type: "userMessage", content: [] },
            { id: "reply", type: "userMessage", content: [] },
            { id: "confirmation", type: "agentMessage", text: "Received" },
          ],
        },
      ],
      questionTurns: [{ id: "turn", items: [question] }],
    },
  };
  const history = mergeConversationHistory(null, response);
  expect(history.turns[0].items.map((item) => item.id)).toEqual([
    "opening",
    "answered-question",
    "reply",
    "confirmation",
  ]);
  const card = createAsyncQuestionCard(history.turns[0].items[1], readAsyncQuestions(question), {
    t: english,
    sendAnswer: async () => {
      throw Error("Historical question must not submit");
    },
  });
  document.body.append(card);
  expect(card.open).toBe(false);
  expect(card.dataset.status).toBe("earlier");
  expect(card.querySelector<HTMLButtonElement>("[type=submit]").hidden).toBe(true);
  expect(card.querySelector<HTMLFieldSetElement>("fieldset").disabled).toBe(true);
  const delta = mergeConversationHistory(history, {
    ...response,
    history: { ...response.history, mode: "delta", turns: [] },
  });
  expect(delta.turns[0].items.filter((item) => item.id === question.id)).toHaveLength(1);
  expect(delta.turns[0].items.find((item) => item.id === question.id).questionState).toBe("earlier");
});

test("native user message records retire a question and paired legacy records do not double-count input", () => {
  const user = (text: string) => ({
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  });
  const legacy = (message: string) => ({ type: "event_msg", payload: { type: "user_message", message } });
  const question = {
    type: "response_item",
    payload: {
      type: "function_call",
      call_id: "native-question",
      name: "request_user_input_async",
      arguments: JSON.stringify({ questions: [{ title: "Continue?", options: ["Yes"] }] }),
    },
  };
  const events = [
    { type: "event_msg", payload: { type: "task_started", turn_id: "native-turn" } },
    user("Opening"),
    legacy("Opening"),
    question,
    user("Continue?\nYes"),
    legacy("Continue?\nYes"),
  ];
  const state = parseRollout(events.map((event) => JSON.stringify(event)).join("\n"));
  expect(state.userSequence).toBe(2);
  expect(state.questionTurns.get("native-turn").items[0].questionState).toBe("earlier");
  expect(state.questionTurns.get("native-turn").items[0].questionUserSequence).toBe(1);
  const repeated = parseRollout([...events, user("Continue?\nYes")].map((event) => JSON.stringify(event)).join("\n"));
  expect(repeated.userSequence).toBe(3);
  const onlyNative = parseRollout(
    events
      .filter((event) => event.payload.type !== "user_message")
      .map((event) => JSON.stringify(event))
      .join("\n"),
  );
  expect(onlyNative.questionTurns.get("native-turn").items[0].questionState).toBe("earlier");
});
