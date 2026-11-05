import { englishMessages } from "../../src/shared/i18n/catalogs.js";

// Expand literal text outside ICU expressions without changing IDs or arguments.
export function pseudoMessage(message) {
  let depth = 0,
    literal = "",
    output = "";
  const flush = () => {
    output +=
      literal.replace(
        /[a-z]/gi,
        (letter) => ({ a: "á", e: "ë", i: "ï", o: "ö", u: "ü" })[letter.toLowerCase()] || letter,
      ) + (literal.trim() ? " ~~~~" : "");
    literal = "";
  };
  for (const character of message) {
    if (character === "{") {
      if (!depth) flush();
      depth++;
      output += character;
    } else if (depth) {
      output += character;
      if (character === "}") depth--;
    } else literal += character;
  }
  flush();
  return "［" + output + "］";
}
export function pseudoCatalog() {
  return Object.fromEntries(
    Object.entries(englishMessages).map(([domain, messages]) => [
      domain,
      Object.fromEntries(Object.entries(messages).map(([key, value]) => [key, pseudoMessage(value)])),
    ]),
  );
}
if (import.meta.main) console.log(JSON.stringify(pseudoCatalog(), null, 2));
