export function createFormatters(context) {
  const cache = new Map();
  const cached = (type, options = {}) => {
    const { locale = "en", timeZone } = context();
    const settings = type === "DateTimeFormat" && timeZone ? { timeZone, ...options } : options;
    const key = JSON.stringify([type, locale, settings]);
    if (!cache.has(key)) {
      if (cache.size >= 64) cache.delete(cache.keys().next().value);
      cache.set(key, new Intl[type](locale, settings));
    }
    return cache.get(key);
  };
  return Object.freeze({
    list: (values, options) => cached("ListFormat", { style: "long", type: "conjunction", ...options }).format(values),
    number: (value, options) => cached("NumberFormat", options).format(value),
    percent: (value, options) => cached("NumberFormat", { style: "percent", ...options }).format(value),
    currency: (value, currency, options) =>
      cached("NumberFormat", { style: "currency", currency, ...options }).format(value),
    dateTime: (value, options) => cached("DateTimeFormat", options).format(value),
    relativeTime: (value, unit, options) =>
      cached("RelativeTimeFormat", { numeric: "auto", style: "short", ...options }).format(value, unit),
    compare: (left, right) => cached("Collator", { sensitivity: "base", numeric: true }).compare(left, right),
    duration: (milliseconds) => {
      const seconds = Math.max(1, Math.round(milliseconds / 1000)),
        minutes = Math.floor(seconds / 60),
        rest = seconds % 60;
      const unit = (value, name) =>
        cached("NumberFormat", { style: "unit", unit: name, unitDisplay: "narrow" }).format(value);
      return minutes
        ? [unit(minutes, "minute"), ...(rest ? [unit(rest, "second")] : [])].join(" ")
        : unit(seconds, "second");
    },
  });
}
