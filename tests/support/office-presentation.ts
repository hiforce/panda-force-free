import { zipSync } from "fflate";
import { PRESENTATION_NAMESPACES, OFFICE_CONTENT_TYPES } from "../../src/server/slides/office/namespaces.js";

/** A self-contained package exercises nonstandard part paths, native groups and encoded image names. */
export function officeFixture(options: { kind?: "pptx" | "potx"; strict?: boolean; slides?: number } = {}) {
  const ns = PRESENTATION_NAMESPACES[options.strict ? 1 : 0]!,
    count = options.slides ?? 1,
    types = "http://schemas.openxmlformats.org/package/2006/content-types",
    relationships = "http://schemas.openxmlformats.org/package/2006/relationships",
    declarations = `xmlns:p="${ns.p}" xmlns:a="${ns.a}" xmlns:r="${ns.r}"`,
    rel = (entries: string) => `<Relationships xmlns="${relationships}">${entries}</Relationships>`,
    edge = (id: string, type: string, target: string, external = false) =>
      `<Relationship Id="${id}" Type="${ns.r}/${type}" Target="${target}"${external ? ' TargetMode="External"' : ""}/>`,
    root = '<p:nvGrpSpPr><p:cNvPr id="1" name="Root"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>',
    text = (id: number, name: string, content: string, placeholder = "") =>
      `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr>${placeholder}</p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr b="1"/><a:t>${content}</a:t></a:r><a:r><a:rPr i="1"/><a:t>world</a:t></a:r><a:br/><a:r><a:t>Next line</a:t></a:r></a:p></p:txBody></p:sp>`,
    picture =
      '<p:pic><p:nvPicPr><p:cNvPr id="3" name="Picture"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdImage"/></p:blipFill><p:spPr><a:xfrm rot="900000" flipH="true"><a:off x="914400" y="457200"/><a:ext cx="1828800" cy="914400"/></a:xfrm></p:spPr></p:pic>',
    group = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="4" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/><a:chOff x="0" y="0"/><a:chExt cx="100" cy="100"/></a:xfrm></p:grpSpPr>${text(5, "Nested", "Nested ")}</p:grpSp>`,
    part = (kind: string, body: string, suffix = "", name = kind) =>
      `<p:${kind} ${declarations}><p:cSld name="${name}"><p:spTree>${root}${body}</p:spTree></p:cSld>${suffix}</p:${kind}>`,
    files: Record<string, string | Uint8Array> = {
      "[Content_Types].xml": `<Types xmlns="${types}"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="bin" ContentType="application/octet-stream"/><Override PartName="/DECK/Root.xml" ContentType="${OFFICE_CONTENT_TYPES[options.kind ?? "pptx"]}"/><Override PartName="/deck/style/master.xml" ContentType="${OFFICE_CONTENT_TYPES.master}"/><Override PartName="/deck/layouts/title.xml" ContentType="${OFFICE_CONTENT_TYPES.layout}"/>${Array.from({ length: count }, (_, i) => `<Override PartName="/deck/pages/p${i + 1}.xml" ContentType="${OFFICE_CONTENT_TYPES.slide}"/>`).join("")}</Types>`,
      "_rels/.rels": rel(edge("office", "officeDocument", "DECK/Root.xml")),
      "deck/Root.xml": `<p:presentation ${declarations}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="master"/></p:sldMasterIdLst><p:sldIdLst>${Array.from({ length: count }, (_, i) => `<p:sldId id="${256 + i}" r:id="s${i + 1}"/>`).join("")}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
      "deck/_rels/Root.xml.rels": rel(
        edge("master", "slideMaster", "style/master.xml") +
          Array.from({ length: count }, (_, i) => edge(`s${i + 1}`, "slide", `pages/p${i + 1}.xml`)).join(""),
      ),
      "deck/style/master.xml": part(
        "sldMaster",
        "",
        '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="layout"/></p:sldLayoutIdLst>',
        "Master",
      ),
      "deck/style/_rels/master.xml.rels": rel(
        edge("layout", "slideLayout", "../layouts/title.xml") + edge("theme", "theme", "theme.xml"),
      ),
      "deck/style/theme.xml": `<a:theme xmlns:a="${ns.a}" name="Fixture"><a:themeElements/></a:theme>`,
      "deck/layouts/title.xml": part(
        "sldLayout",
        text(2, "Title", "Layout ", '<p:ph type="ctrTitle"/>'),
        "",
        "Title layout",
      ),
      "deck/layouts/_rels/title.xml.rels": rel(edge("master", "slideMaster", "../STYLE/MASTER.XML")),
      "deck/media/hero%20photo.png": new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      "opaque/data.bin": new Uint8Array([0, 1, 255, 0]),
    };
  for (let i = 1; i <= count; i++) {
    files[`deck/pages/p${i}.xml`] = part(
      "sld",
      text(2, "Title", "Hello ", "<p:ph/>") + picture + group,
      "",
      `Page ${i}`,
    );
    files[`deck/pages/_rels/p${i}.xml.rels`] = rel(
      edge("layout", "slideLayout", "../layouts/title.xml") +
        edge("rIdImage", "image", "../media/hero%20photo.png") +
        edge("external", "hyperlink", "https://outside.invalid/no-fetch", true),
    );
  }
  const bytes = (current = files) =>
    zipSync(
      Object.fromEntries(
        Object.entries(current).map(([path, value]) => [
          path,
          typeof value === "string" ? new TextEncoder().encode(value) : value,
        ]),
      ),
      { level: 0 },
    );
  return { files, bytes, ns };
}
