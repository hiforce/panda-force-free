type Choice = { id: string; label: string };
const levels = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

/** Native discrete steps retain keyboard/touch behavior and only expose supported choices. */
export function mountReasoningSlider(
  host: HTMLElement,
  choices: readonly Choice[],
  selected: string,
  label: string,
  onChange: (value: string) => void,
) {
  const options = [...new Map(choices.map((item) => [item.id, item])).values()].sort(
    (a, b) => (levels.indexOf(a.id) + 1 || 99) - (levels.indexOf(b.id) + 1 || 99),
  );
  host.replaceChildren();
  if (!options.length) return;
  const field = document.createElement("div"),
    caption = document.createElement("div"),
    title = document.createElement("span"),
    output = document.createElement("output"),
    input = document.createElement("input"),
    ticks = document.createElement("div"),
    endpoints = document.createElement("div");
  field.className = "wb-range-field";
  caption.className = "wb-range-caption";
  title.textContent = label;
  output.className = "wb-range-value";
  caption.append(title, output);
  input.className = "wb-range-input";
  input.type = "range";
  input.min = "0";
  input.max = String(options.length - 1);
  input.step = "1";
  input.value = String(
    Math.max(
      0,
      options.findIndex((item) => item.id === selected),
    ),
  );
  input.disabled = options.length === 1;
  input.setAttribute("aria-label", label);
  ticks.className = "wb-range-ticks";
  ticks.setAttribute("aria-hidden", "true");
  for (const option of options) {
    const tick = document.createElement("span");
    tick.title = option.label;
    ticks.append(tick);
  }
  endpoints.className = "wb-range-endpoints";
  endpoints.setAttribute("aria-hidden", "true");
  for (const option of options.length > 1 ? [options[0]!, options.at(-1)!] : [options[0]!]) {
    const endpoint = document.createElement("span");
    endpoint.textContent = option.label;
    endpoints.append(endpoint);
  }
  const update = () => {
    const index = Math.max(0, Math.min(options.length - 1, Math.round(input.valueAsNumber))),
      option = options[index]!;
    output.value = option.label;
    input.setAttribute("aria-valuetext", option.label);
    input.style.setProperty("--range-fill", `${(index / Math.max(1, options.length - 1)) * 100}%`);
    return option.id;
  };
  let committed = update();
  const commit = () => {
    const value = update();
    if (value === committed) return;
    committed = value;
    onChange(value);
  };
  input.oninput = commit;
  input.onchange = commit;
  field.append(caption, input, ticks, endpoints);
  host.append(field);
}
