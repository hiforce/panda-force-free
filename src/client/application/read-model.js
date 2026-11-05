const views = new WeakMap(),
  originals = new WeakMap();
const isData = (value) =>
  value &&
  typeof value === "object" &&
  (Array.isArray(value) || [Object.prototype, null].includes(Object.getPrototypeOf(value)));

// Protect business snapshots without freezing the canonical records or DOM objects.
export function readonlyData(value) {
  if (!isData(value)) return value;
  if (originals.has(value)) return value;
  if (views.has(value)) return views.get(value);
  const deny = () => {
    throw new Error("Read-only domain record; use its mutation capability");
  };
  const view = new Proxy(value, {
    get: (target, key, receiver) => readonlyData(Reflect.get(target, key, receiver)),
    set: deny,
    deleteProperty: deny,
    defineProperty: deny,
    setPrototypeOf: deny,
    preventExtensions: deny,
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      return descriptor?.configurable && "value" in descriptor
        ? { ...descriptor, value: readonlyData(descriptor.value) }
        : descriptor;
    },
  });
  views.set(value, view);
  originals.set(view, value);
  return view;
}

// New records can contain values selected from a read model. Remove those views
// before committing or structured-cloning so only canonical data is stored.
export function canonicalData(value, seen = new WeakSet()) {
  if (originals.has(value)) return originals.get(value);
  if (!isData(value) || seen.has(value)) return value;
  seen.add(value);
  for (const key of Object.keys(value)) {
    const before = value[key],
      after = canonicalData(before, seen);
    if (before !== after) value[key] = after;
  }
  return value;
}
