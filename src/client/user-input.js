export const USER_INPUT_METHODS = ["item/tool/requestUserInput", "tool/requestUserInput"];

export function createUserInputCard(
  request,
  {
    t,
    respond,
    onResolved,
    onError,
    draft = {},
    submitLabel = "Submit answer",
    headingLabel = "Waiting for your answer",
  },
) {
  const card = document.createElement("section");
  card.className = "user-input-card";
  card.dataset.requestId = String(request.id);
  card.dataset.i18nIgnore = "";
  const form = document.createElement("form");
  const heading = document.createElement("strong");
  heading.className = "user-input-title";
  heading.textContent = t(headingLabel);
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
    progress.textContent = t("Answered {answered} of {total} questions", { answered, total: fields.length });
  };
  for (const [index, question] of (request.params?.questions || []).entries()) {
    const fieldset = document.createElement("fieldset");
    fieldset.dataset.questionId = question.id;
    const legend = document.createElement("legend");
    legend.textContent = `${index + 1} / ${request.params.questions.length}${question.header ? " · " + question.header : ""}`;
    const prompt = document.createElement("p");
    prompt.className = "user-input-question";
    prompt.textContent = question.question;
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
    hint.textContent = t(
      options.length ? "Choose one option for this question." : "Enter an answer for this question.",
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
      title.textContent = label;
      copy.append(title);
      if (description) {
        const detail = document.createElement("small");
        detail.textContent = description;
        copy.append(detail);
      }
      option.append(radio, copy);
      fieldset.append(option);
      radios.push(radio);
    }
    options.forEach((option, optionIndex) => addOption(option.label, option.description, String(optionIndex)));
    if (options.length && customAllowed) addOption(t("Write your own answer"), "", "custom");
    if (customAllowed) {
      custom = document.createElement(question.isSecret ? "input" : "textarea");
      if (question.isSecret) {
        custom.type = "password";
        custom.autocomplete = "off";
      } else custom.rows = 2;
      custom.className = "user-input-custom";
      custom.setAttribute("aria-label", question.question);
      custom.placeholder = t("Write your answer…");
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
  submit.textContent = t(submitLabel);
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
          custom.setCustomValidity(t("Please enter an answer before submitting."));
          custom.reportValidity();
        }
        custom?.focus();
        return;
      }
      answers[question.id] = { answers: [answer] };
    }
    error.hidden = true;
    submit.disabled = true;
    submit.textContent = t("Submitting…");
    for (const { fieldset } of fields) fieldset.disabled = true;
    try {
      await respond(request.id, { answers });
      onResolved(request.id);
    } catch (failure) {
      if (!card.isConnected) return;
      error.textContent = failure.message || t("Could not submit answer");
      error.hidden = false;
      onError(error.textContent);
      submit.disabled = false;
      submit.textContent = t(submitLabel);
      for (const { fieldset } of fields) fieldset.disabled = false;
    }
  };
  return card;
}
