/** @type {WeakMap<object, {name: string; initialized: boolean}>} */
const slots = new WeakMap();

/** A peer can be captured during construction and read only after installation.
 * @template {object} T
 * @param {string} name
 * @returns {T}
 */
export function createFeaturePort(name) {
  const state = { name, initialized: false };
  const port = new Proxy(
    {},
    {
      get(target, property, receiver) {
        if (!state.initialized)
          throw new Error(`Feature port ${name} was read before installation: ${String(property)}`);
        return Reflect.get(target, property, receiver);
      },
      set() {
        throw new Error(`Feature port ${name} is read-only`);
      },
    },
  );
  slots.set(port, state);
  return /** @type {T} */ (port);
}

/** The target fixes the contract; an implementation cannot widen it during inference.
 * @template {object} T
 * @param {T} port
 * @param {NoInfer<T>} implementation
 * @returns {T}
 */
export function installFeature(port, implementation) {
  const state = slots.get(port);
  if (!state) throw new Error("Cannot install an unregistered feature port");
  if (state.initialized) throw new Error(`Feature port ${state.name} is already installed`);
  Object.defineProperties(port, Object.getOwnPropertyDescriptors(implementation));
  state.initialized = true;
  return Object.freeze(port);
}
