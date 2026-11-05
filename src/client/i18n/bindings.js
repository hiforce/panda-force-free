const OWNER = Symbol.for("PandaForce.messageBindingOwner");
const bindingAttribute = "data-pf-message";
const attributeNames = ["title", "placeholder", "aria-label", "data-tooltip"];

export function createMessageBindings(i18n) {
  const state = new WeakMap(),
    references = new Set();
  const collected = new FinalizationRegistry((reference) => references.delete(reference));
  function remember(element, slot, id, values) {
    if (!element) return;
    let fields = state.get(element);
    if (!fields) {
      fields = new Map();
      state.set(element, fields);
      const reference = new WeakRef(element);
      references.add(reference);
      collected.register(element, reference, reference);
    }
    element[OWNER] = {
      clear: (name) => {
        fields.delete(name);
        element.removeAttribute(name === "text" ? bindingAttribute : "data-pf-" + name);
      },
    };
    fields.set(slot, { id, values });
    const value = i18n.t(id, values);
    if (slot === "text") element.textContent = value;
    else element.setAttribute(slot, value);
  }
  const text = (element, id, values) => remember(element, "text", id, values);
  const attribute = (element, name, id, values) => remember(element, name, id, values);
  function bind(root) {
    if (!root?.querySelectorAll) return;
    const selector = [bindingAttribute, ...attributeNames.map((name) => "data-pf-" + name)]
      .map((name) => `[${name}]`)
      .join(",");
    const elements = [...(root.matches?.(selector) ? [root] : []), ...root.querySelectorAll(selector)];
    for (const element of elements) {
      let values = {};
      try {
        values = JSON.parse(element.getAttribute("data-pf-values") || "{}");
      } catch {}
      if (element.hasAttribute(bindingAttribute) && !state.get(element)?.has("text"))
        text(element, element.getAttribute(bindingAttribute), values);
      for (const name of attributeNames)
        if (element.hasAttribute("data-pf-" + name) && !state.get(element)?.has(name))
          attribute(element, name, element.getAttribute("data-pf-" + name), values);
    }
  }
  const refresh = () => {
    for (const reference of references) {
      const element = reference.deref();
      if (!element) {
        references.delete(reference);
        continue;
      }
      if (!element.isConnected) continue;
      for (const [slot, { id, values }] of state.get(element) || []) {
        if (slot === "text") element.textContent = i18n.t(id, values);
        else element.setAttribute(slot, i18n.t(id, values));
      }
    }
  };
  const unsubscribe = i18n.subscribe(refresh);
  return Object.freeze({
    text,
    attribute,
    bind,
    refresh,
    disconnect() {
      unsubscribe();
      for (const reference of references) collected.unregister(reference);
      references.clear();
    },
  });
}

export function clearMessageBinding(element, slot = "text") {
  element?.[OWNER]?.clear(slot);
}
export function setOpaqueText(element, value) {
  clearMessageBinding(element, "text");
  element.textContent = value;
  return value;
}
export function setOpaqueAttribute(element, name, value) {
  clearMessageBinding(element, name);
  element.setAttribute(name, value);
  return value;
}
