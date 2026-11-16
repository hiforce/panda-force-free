export interface ChannelTemplateStyle {
  version: string;
  font: string;
  color: string;
  accent: string;
  width: string;
  size: string;
}
export interface TemplateSnapshot {
  id: string;
  version: string;
  style: ChannelTemplateStyle;
}
/** Style snapshots remain portable data, with no HTML, functions or free-form CSS. */
export function validTemplateSnapshot(value: TemplateSnapshot): TemplateSnapshot {
  const style = value?.style;
  if (
    !value ||
    typeof value.id !== "string" ||
    !/^[a-z][a-z0-9.-]{0,63}$/.test(value.id) ||
    typeof value.version !== "string" ||
    !/^\d{1,4}(?:\.\d{1,4}\.\d{1,4})?$/.test(value.version) ||
    !style ||
    Object.keys(style).some((key) => !["version", "font", "color", "accent", "width", "size"].includes(key)) ||
    !["Georgia,serif", "Arial,sans-serif", "system-ui,sans-serif"].includes(style.font) ||
    !/^#[a-f0-9]{6}$/i.test(style.color) ||
    !/^#[a-f0-9]{6}$/i.test(style.accent) ||
    !/^(?:6[4-9]0|[7-8]\d0|9[0-6]0)px$/.test(style.width) ||
    !/^(?:1[4-9]|2[0-2])px$/.test(style.size) ||
    style.version !== value.version
  )
    throw new Error("invalidTemplate");
  return {
    id: value.id,
    version: value.version,
    style: {
      version: style.version,
      font: style.font,
      color: style.color,
      accent: style.accent,
      width: style.width,
      size: style.size,
    },
  };
}
