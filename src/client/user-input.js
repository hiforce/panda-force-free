import { localizeAttribute, localizeText, setOpaqueText } from "./i18n.js";

export const USER_INPUT_METHODS = ["item/tool/requestUserInput", "tool/requestUserInput"];

export function createUserInputCard(
  request,
  {
    t,
    respond,
    onResolved,
    onError,
    draft = {},
    submitLabel = "common.submitAnswer",
    headingLabel = "common.waitingForYourAnswer",
  },
) {
  const card = document.createElement("section");
  card.className = "user-input-card";
  card.dataset.requestId = String(request.id);
  card.dataset.i18nIgnore = "";
  const form = document.createElement("form");
  const heading = document.createElement("strong");
  heading.className = "user-input-title";
  localizeText(heading, headingLabel, undefined, t);
  form.append(heading);
  const progress = document.createElement("p");
  progress.className = "user-input-progress";
  progress.setAttribute("aria-live", "polite");
  form.append(progress);
  const fields = [];
  const updateProgress = () => {
    const answered = fields.filter(({ question, saved }) =>
      !question.options?.length || saved.selected === "custom" ? Boolean(saved.text.trim()) : saved.selected !== "",
    ).length;
    localizeText(progress, "approvals.answeredAnsweredOfTotalQuestions", { answered, total: fields.length }, t);
  };
  for (const [index, question] of (request.params?.questions || []).entries()) {
    const fieldset = document.createElement("fieldset");
    fieldset.dataset.questionId = question.id;
    const legend = document.createElement("legend");
    setOpaqueText(
      legend,
      `${index + 1} / ${request.params.questions.length}${question.header ? " · " + question.header : ""}`,
    );
    const prompt = document.createElement("p");
    prompt.className = "user-input-question";
    setOpaqueText(prompt, question.question);
    fieldset.append(legend, prompt);
    // Native question IDs are opaque data, including names such as __proto__.
    let saved = Object.hasOwn(draft, question.id) ? draft[question.id] : null;
    if (!saved || typeof saved.selected !== "string" || typeof saved.text !== "string") {
      saved = { selected: "", text: "" };
      Object.defineProperty(draft, question.id, { value: saved, writable: true, enumerable: true, configurable: true });
    }
    const radios = [];
    const options = question.options || [];
    const hint = document.createElement("p");
    hint.className = "user-input-hint";
    localizeText(
      hint,
      options.length ? "common.chooseOneOptionForThisQuestion" : "common.enterAnAnswerForThisQuestion",
      undefined,
      t,
    );
    fieldset.append(hint);
    const customAllowed = !options.length || question.isOther === true;
    let custom;
    const update = () => {
      for (const radio of radios) radio.closest("label").classList.toggle("selected", radio.checked);
      if (custom) {
        custom.hidden = options.length > 0 && saved.selected !== "custom";
        custom.required = !custom.hidden;
        custom.disabled = custom.hidden;
      }
    };
    function addOption(label, description, value) {
      const option = document.createElement("label");
      option.className = "user-input-option";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = `question-${request.id}-${index}`;
      radio.value = value;
      radio.required = true;
      radio.checked = saved.selected === value;
      radio.onchange = () => {
        saved.selected = value;
        update();
        updateProgress();
        if (value === "custom") custom?.focus();
      };
      const copy = document.createElement("span");
      const title = document.createElement("strong");
      setOpaqueText(title, label);
      copy.append(title);
      if (description) {
        const detail = document.createElement("small");
        setOpaqueText(detail, description);
        copy.append(detail);
      }
      option.append(radio, copy);
      fieldset.append(option);
      radios.push(radio);
    }
    options.forEach((option, optionIndex) => addOption(option.label, option.description, String(optionIndex)));
    if (options.length && customAllowed) addOption(t("approvals.writeYourOwnAnswer"), "", "custom");
    if (customAllowed) {
      custom = document.createElement(question.isSecret ? "input" : "textarea");
      if (question.isSecret) {
        custom.type = "password";
        custom.autocomplete = "off";
      } else custom.rows = 2;
      custom.className = "user-input-custom";
      custom.setAttribute("aria-label", question.question);
      localizeAttribute(custom, "placeholder", "approvals.writeYourAnswer", undefined, t);
      custom.value = saved.text;
      custom.oninput = () => {
        saved.text = custom.value;
        custom.setCustomValidity("");
        updateProgress();
      };
      fieldset.append(custom);
    }
    fields.push({ question, saved, custom, fieldset });
    update();
    form.append(fieldset);
  }
  updateProgress();
  const error = document.createElement("p");
  error.className = "user-input-error";
  error.setAttribute("role", "alert");
  error.hidden = true;
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "user-input-submit";
  localizeText(submit, submitLabel, undefined, t);
  form.append(error, submit);
  card.append(form);
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (submit.disabled || !fields.length || !form.reportValidity()) return;
    const answers = Object.create(null);
    for (const { question, saved, custom } of fields) {
      const answer =
        !question.options?.length || saved.selected === "custom"
          ? custom.value.trim()
          : question.options[Number(saved.selected)]?.label;
      if (!answer) {
        if (custom) {
          custom.setCustomValidity(t("approvals.pleaseEnterAnAnswerBeforeSubmitting"));
          custom.reportValidity();
        }
        custom?.focus();
        return;
      }
      answers[question.id] = { answers: [answer] };
    }
    error.hidden = true;
    submit.disabled = true;
    localizeText(submit, "approvals.submitting", undefined, t);
    for (const { fieldset } of fields) fieldset.disabled = true;
    try {
      await respond(request.id, { answers });
      onResolved(request.id);
    } catch (failure) {
      if (!card.isConnected) return;
      setOpaqueText(error, failure.message || t("errors.couldNotSubmitAnswer"));
      error.hidden = false;
      onError(error.textContent);
      submit.disabled = false;
      localizeText(submit, submitLabel, undefined, t);
      for (const { fieldset } of fields) fieldset.disabled = false;
    }
  };
  return card;
}
