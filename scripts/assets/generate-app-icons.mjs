import { LAUNCH_SCREENS } from "../../src/shared/install-assets.js";
import { readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";

// Keep the complete mark inside the maskable icon safe area.
const mark = readFileSync("public/assets/panda-mark.svg");
for (const [name, size] of [
  ["touch-180", 180],
  ["app-192", 192],
  ["app-512", 512],
]) {
  const logo = await sharp(mark)
    .resize(Math.round(size * 0.7))
    .png()
    .toBuffer();
  await sharp({ create: { width: size, height: size, channels: 3, background: "#f8f9fc" } })
    .composite([{ input: logo, gravity: "centre" }])
    .removeAlpha()
    .png()
    .toFile(`public/assets/panda-${name}.png`);
}

for (const screen of LAUNCH_SCREENS) {
  const logoSize = 64 * screen.scale;
  const logo = await sharp(mark).resize(logoSize).png().toBuffer();
  const title = Buffer.from(
    `<svg width="${screen.width}" height="${48 * screen.scale}" xmlns="http://www.w3.org/2000/svg"><text x="50%" y="${30 * screen.scale}" text-anchor="middle" font-family="Arial, sans-serif" font-weight="600" font-size="${24 * screen.scale}" fill="${screen.theme === "dark" ? "#f1f3f9" : "#202535"}">PandaForce</text></svg>`,
  );
  await sharp({
    create: {
      width: screen.width,
      height: screen.height,
      channels: 3,
      background: screen.theme === "dark" ? "#17191f" : "#f8f9fc",
    },
  })
    .composite([
      {
        input: logo,
        left: Math.round((screen.width - logoSize) / 2),
        top: Math.round(screen.height / 2 - 70 * screen.scale),
      },
      { input: title, left: 0, top: Math.round(screen.height / 2 + 10 * screen.scale) },
    ])
    .removeAlpha()
    .png()
    .toFile("public" + screen.path);
}
const index = "public/index.html";
const html = readFileSync(index, "utf8");
const links = LAUNCH_SCREENS.map(
  (screen) => `    <link rel="apple-touch-startup-image" href="${screen.path}" media="${screen.media}" />`,
).join("\n");
writeFileSync(
  index,
  html.replace(
    / {4}<!-- Home Screen launch images -->[\s\S]*? {4}<!-- End Home Screen launch images -->/,
    `    <!-- Home Screen launch images -->\n${links}\n    <!-- End Home Screen launch images -->`,
  ),
);
