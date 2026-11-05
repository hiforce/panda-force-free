import { IntlMessageFormat } from "intl-messageformat";

// ICU parsing is shared by the release validator and plugin registration.
export function messageContract(message) {
  if (typeof message !== "string" || !message.trim()) throw new Error("Messages must be non-empty strings");
  const parameters = new Map();
  function visit(nodes) {
    for (const node of nodes) {
      if (node.type === 0 || node.type === 7) continue;
      if (node.type === 8) throw new Error("Message markup must be rendered by the owning component");
      const type = [2, 6].includes(node.type) ? "number" : [3, 4].includes(node.type) ? "date" : "string";
      if (parameters.has(node.value) && parameters.get(node.value) !== type)
        throw new Error("Conflicting parameter type: " + node.value);
      parameters.set(node.value, type);
      for (const option of Object.values(node.options || {})) visit(option.value);
    }
  }
  visit(new IntlMessageFormat(message, "en").getAst());
  return Object.fromEntries([...parameters].sort(([left], [right]) => left.localeCompare(right)));
}

export function validateNamespace(english, translations = {}) {
  if (!english || typeof english !== "object" || Array.isArray(english)) throw new Error("Invalid English namespace");
  const contracts = Object.fromEntries(
    Object.entries(english).map(([key, value]) => {
      if (!/^[a-z0-9][a-zA-Z0-9]*$/.test(key)) throw new Error("Invalid message ID: " + key);
      return [key, messageContract(value)];
    }),
  );
  for (const messages of Object.values(translations)) {
    if (!messages || typeof messages !== "object" || Array.isArray(messages))
      throw new Error("Invalid translation namespace");
    for (const [key, value] of Object.entries(messages)) {
      if (!Object.hasOwn(contracts, key) || JSON.stringify(messageContract(value)) !== JSON.stringify(contracts[key]))
        throw new Error("Translation parameter contract differs: " + key);
    }
  }
  return contracts;
}
