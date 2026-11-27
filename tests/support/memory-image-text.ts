import sharp from "sharp";

export const recognizedImageText = {
  en: "VERDANT CERAMIC GASKET",
  simplified: "防火安全检查",
  traditional: "緊急安全出口",
  excluded: "uncataloguedmarker",
};

export function memoryImageTextFixture(locale: "en" | "simplified" | "traditional" = "en") {
  const words = recognizedImageText;
  const font = { en: "Noto Sans", simplified: "Noto Sans CJK SC", traditional: "Noto Sans CJK TC" }[locale];
  return sharp(
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="720">
  <rect width="1440" height="720" fill="white"/>
  <g fill="#17272c">
    <text x="120" y="150" font-family="${font}" font-size="76" font-weight="600">${words[locale]}</text>
    <text x="120" y="670" font-family="Noto Sans" font-size="44">password = ${words.excluded}</text>
  </g>
</svg>`),
  )
    .png()
    .toBuffer();
}
