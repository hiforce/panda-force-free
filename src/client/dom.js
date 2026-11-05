/**
 * @template {string} S
 * @param {S} selector
 * @param {ParentNode | null} [root]
 * @returns {import('./dom-elements.js').SelectedElement<S> | null}
 */
export function findElement(selector, root = document) {
  if (!root || (arguments.length > 1 && arguments[1] == null)) return null;
  const element = root.querySelector(selector);
  return /** @type {import('./dom-elements.js').SelectedElement<S> | null} */ (element);
}

/**
 * @template {string} S
 * @param {S} selector
 * @param {ParentNode | null} [root]
 * @returns {import('./dom-elements.js').SelectedElement<S>}
 */
export function requireElement(selector, root = document) {
  const element = findElement(selector, root);
  if (!element) throw new Error(`Required interface element is missing: ${selector}`);
  return element;
}

/**
 * @template {string} S
 * @param {S} selector
 * @param {ParentNode | null} [root]
 * @returns {Array<import('./dom-elements.js').SelectedElement<S>>}
 */
export function findElements(selector, root = document) {
  if (!root || (arguments.length > 1 && arguments[1] == null)) return [];
  return /** @type {Array<import('./dom-elements.js').SelectedElement<S>>} */ (
    Array.from(root.querySelectorAll(selector))
  );
}

/**
 * @template {string} S
 * @param {S} selector
 * @param {EventTarget | null | undefined} target
 * @returns {import('./dom-elements.js').SelectedElement<S> | null}
 */
export function closestElement(selector, target) {
  if (
    !target ||
    !("nodeType" in target) ||
    target.nodeType !== 1 ||
    !("closest" in target) ||
    typeof target.closest !== "function"
  )
    return null;
  return /** @type {import('./dom-elements.js').SelectedElement<S> | null} */ (target.closest(selector));
}

/** @param {Element} element @returns {element is HTMLInputElement} */
export function isInputElement(element) {
  return element.localName === "input";
}
