import { englishMessages } from "./catalogs.js";

/** @param {unknown} id @returns {id is import('./messages.js').MessageId} */
export function isMessageId(id) {
  if (typeof id !== "string") return false;
  const separator = id.indexOf(".");
  const namespace = id.slice(0, separator);
  return (
    Object.hasOwn(englishMessages, namespace) && Object.hasOwn(englishMessages[namespace], id.slice(separator + 1))
  );
}
