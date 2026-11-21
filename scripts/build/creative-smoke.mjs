#!/usr/bin/env node
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const home = process.env.PANDA_FORCE_CREATIVE_HOME || "/opt/panda-creative";
const require = createRequire(join(home, "node/package.json"));
const directory = process.argv[2] || mkdtempSync(join(tmpdir(), "panda-tools-smoke-"));
const run = (command, args) => {
  const child = spawnSync(command, args, {
    cwd: directory,
    encoding: "utf8",
    timeout: 90000,
    env: { ...process.env, MPLCONFIGDIR: join(directory, "matplotlib") },
  });
  if (child.status !== 0) throw Error(`${command} failed: ${child.stderr?.slice(-3000)}`);
  return child.stdout;
};
if (existsSync("/app/package.json")) {
  const application = createRequire("/app/package.json");
  await application("sharp")({ text: { text: "中文創作", font: "Noto Sans CJK SC 24", rgba: true } })
    .png()
    .toFile(join(directory, "application-fonts.png"));
  await new Promise((resolve, reject) => {
    const terminal = application("node-pty").spawn("/bin/sh", ["-c", "printf panda-native"], {
      cwd: directory,
      cols: 80,
      rows: 24,
    });
    let output = "";
    const timeout = setTimeout(() => {
      terminal.kill();
      reject(Error("Native terminal stalled"));
    }, 10000);
    terminal.onData((data) => {
      output += data;
    });
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timeout);
      if (exitCode !== 0 || !output.includes("panda-native")) reject(Error("Native terminal output missing"));
      else resolve();
    });
  });
}
const pptx = new (require("pptxgenjs"))();
pptx.layout = "LAYOUT_WIDE";
for (const title of ["Panda creative toolchain", "中国近代史 · 創作環境驗證"]) {
  const slide = pptx.addSlide();
  slide.addText(title, { x: 0.8, y: 1, w: 11.6, h: 1.4, fontFace: "Noto Sans CJK SC", fontSize: 30 });
}
await pptx.writeFile({ fileName: join(directory, "slides.pptx") });
run("soffice", [
  `-env:UserInstallation=file://${directory}/office-profile`,
  "--headless",
  "--convert-to",
  "pdf",
  "--outdir",
  directory,
  join(directory, "slides.pptx"),
]);
if (!/Pages:\s+2\b/.test(run("pdfinfo", ["slides.pdf"]))) throw Error("Office did not render both slides");
const text = run("pdftotext", ["slides.pdf", "-"]);
if (!text.includes("中国近代史")) throw Error("Slide PDF lost its Chinese text");
run("pdftoppm", ["-f", "1", "-singlefile", "-scale-to", "960", "-png", "slides.pdf", "slide-preview"]);
const sharp = require("sharp");
await sharp(join(directory, "slide-preview.png")).resize(480).webp().toFile(join(directory, "preview.webp"));
const docx = require("docx");
writeFileSync(
  join(directory, "writing.docx"),
  await docx.Packer.toBuffer(
    new docx.Document({ sections: [{ children: [new docx.Paragraph("Panda writing · 中文教案")] }] }),
  ),
);
run("soffice", [
  `-env:UserInstallation=file://${directory}/writer-profile`,
  "--headless",
  "--convert-to",
  "pdf",
  "--outdir",
  directory,
  join(directory, "writing.docx"),
]);
run("python3", [
  "-c",
  [
    "from PIL import Image",
    "from pptx import Presentation",
    "from docx import Document",
    "from openpyxl import Workbook",
    "import httpx, bs4, pandas, matplotlib; matplotlib.use('Agg')",
    "import matplotlib.pyplot as plt",
    "assert len(Presentation('slides.pptx').slides)==2",
    "assert 'Panda writing' in Document('writing.docx').paragraphs[0].text",
    "assert Image.open('slide-preview.png').width > 0",
    "Workbook().save('research.xlsx')",
    "assert bs4.BeautifulSoup('<article>Panda research</article>', 'lxml').article.text == 'Panda research'",
    "client=httpx.Client(transport=httpx.MockTransport(lambda req: httpx.Response(200,text='offline research fixture')))",
    "assert client.get('https://fixture.invalid').status_code==200",
    "pandas.DataFrame({'x':[1,2],'y':[2,4]}).plot(x='x',y='y'); plt.savefig('research.png')",
  ].join("\n"),
]);
writeFileSync(join(directory, "writing.md"), "# Panda writing\n\nA tested Markdown export.\n");
run("pandoc", ["-f", "markdown", "-t", "html", "-o", "writing.html", "writing.md"]);
if (!readFileSync(join(directory, "writing.html"), "utf8").includes("Panda writing"))
  throw Error("Markdown export is empty");
const browser = await require("playwright").chromium.launch({ headless: true, args: ["--no-sandbox"] });
try {
  const page = await browser.newPage();
  await page.setContent(
    '<!doctype html><html><meta charset="utf-8"><body style="font-family:Noto Sans CJK SC"><h1>Panda · 網頁創作</h1></body></html>',
  );
  await page.screenshot({ path: join(directory, "web.png") });
  await page.pdf({ path: join(directory, "web.pdf") });
} finally {
  await browser.close();
}
run("ffmpeg", [
  "-y",
  "-hide_banner",
  "-loglevel",
  "error",
  "-f",
  "lavfi",
  "-i",
  "color=c=teal:s=320x240:r=12:d=1",
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  "video.mp4",
]);
if (
  !run("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name", "-of", "csv=p=0", "video.mp4"]).includes("h264")
)
  throw Error("H.264 encoder unavailable");
const languages = run("tesseract", ["--list-langs"]);
for (const language of ["eng", "chi_sim", "chi_tra"])
  if (!languages.includes(language)) throw Error(`OCR language missing: ${language}`);
const result = {
  schema: 1,
  passed: true,
  operatingSystem: readFileSync("/etc/os-release", "utf8"),
  directory,
  office: run("soffice", ["--version"]).trim(),
  python: run("python3", ["--version"]).trim(),
  profiles: ["slides", "images", "research", "writing", "web", "video"],
  network: "disabled by caller",
  slides: 2,
  video: "h264",
};
writeFileSync(join(directory, "proof.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result));
