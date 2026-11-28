import { codexIcon } from "../codex-icons.js";
import { setMessageHtml, setOpaqueText } from "../i18n.js";
import { executorIcon, type ExecutorBrand } from "./executor-brands.js";

export function createExecutorPicker(select: HTMLSelectElement) {
  const picker = document.createElement("details");
  picker.className = "executor-picker";
  setMessageHtml(
    picker,
    `<summary class="executor-picker-trigger">
      <span class="executor-picker-mark"></span>
      <span class="executor-picker-value"></span>
      ${codexIcon("chevronDown")}
    </summary><div class="executor-picker-options" role="group"></div>`,
  );
  const trigger = picker.querySelector("summary")!;
  const mark = trigger.querySelector<HTMLElement>(".executor-picker-mark")!;
  const label = trigger.querySelector<HTMLElement>(".executor-picker-value")!;
  const options = picker.querySelector<HTMLElement>(".executor-picker-options")!;
  let signature = "";
  select.hidden = true;
  select.classList.add("executor-picker-native");
  select.after(picker);

  // A touch can shift focus before its click arrives. Dismiss on the completed outside click.
  function dismissOutside(event: MouseEvent) {
    if (!event.composedPath().includes(picker)) setOpen(false);
  }

  function setOpen(open: boolean) {
    picker.open = open;
    if (open) document.addEventListener("click", dismissOutside, true);
    else document.removeEventListener("click", dismissOutside, true);
  }

  trigger.onclick = (event) => {
    event.preventDefault();
    if (!select.disabled) setOpen(!picker.open);
  };
  picker.onkeydown = (event) => {
    if (select.disabled) return;
    if (event.key === "Escape" && picker.open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.focus({ preventScroll: true });
    } else if (event.key === "Tab" && picker.open) {
      requestAnimationFrame(() => {
        if (!picker.contains(document.activeElement)) setOpen(false);
      });
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const buttons = [...options.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      const active = buttons.findIndex((button) => button === document.activeElement);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? buttons.length - 1
            : event.key === "ArrowDown"
              ? Math.min(active + 1, buttons.length - 1)
              : active < 0
                ? buttons.length - 1
                : Math.max(active - 1, 0);
      setOpen(true);
      buttons[next]?.focus();
    }
  };

  return {
    close: () => setOpen(false),
    update(fieldLabel: string, brands: ReadonlyMap<string, ExecutorBrand>) {
      const choices = [...select.options]
        .filter((option) => !option.hidden)
        .map((option) => ({
          value: option.value,
          label: option.label,
          disabled: option.disabled,
          brand: brands.get(option.value),
        }));
      const selected = select.selectedOptions[0];
      const selectedBrand = brands.get(select.value);
      setOpaqueText(label, selected?.label ?? "");
      if ((mark.firstElementChild?.getAttribute("data-executor-brand") ?? undefined) !== selectedBrand)
        setMessageHtml(mark, selectedBrand ? executorIcon(selectedBrand) : "");
      trigger.setAttribute("aria-label", fieldLabel + (selected ? ". " + selected.label : ""));
      trigger.setAttribute("aria-disabled", String(select.disabled));
      trigger.tabIndex = select.disabled ? -1 : 0;
      if (select.disabled) setOpen(false);
      options.setAttribute("aria-label", fieldLabel);
      const next = JSON.stringify(choices);
      if (signature !== next) {
        signature = next;
        const buttons = choices.map((choice) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "executor-picker-option";
          button.dataset.value = choice.value;
          button.disabled = choice.disabled;
          setMessageHtml(
            button,
            `${choice.brand ? executorIcon(choice.brand) : ""}<span class="executor-picker-option-label"></span>`,
          );
          setOpaqueText(button.querySelector("span.executor-picker-option-label")!, choice.label);
          button.onclick = () => {
            if (select.disabled) return;
            if (select.value !== choice.value) {
              select.value = choice.value;
              select.dispatchEvent(new Event("change", { bubbles: true }));
            }
            setOpen(false);
            trigger.focus({ preventScroll: true });
          };
          return button;
        });
        options.replaceChildren(...buttons);
      }
      for (const button of options.querySelectorAll<HTMLButtonElement>("button")) {
        button.setAttribute("aria-pressed", String(button.dataset.value === select.value));
      }
    },
  };
}
