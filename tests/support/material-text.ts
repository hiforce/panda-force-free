import { zipSync } from "fflate";

/** Small authored fixtures contain no external fonts, proprietary files or encryption tools. */
export function materialPdf(objects: string[], trailer = "") {
  let text = "%PDF-1.7\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(text));
    text += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(text);
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  text += offsets.map((offset) => String(offset).padStart(10, "0") + " 00000 n \n").join("");
  text += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailer} >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(text);
}
export function textPdf(options: { text?: string; chinese?: boolean; encrypted?: boolean; pages?: number } = {}) {
  const count = options.pages ?? 1,
    chinese = options.chinese,
    content = chinese
      ? "BT /F1 12 Tf 20 750 Td <0001000200030004> Tj ET"
      : `BT /F1 12 Tf 20 750 Td (${options.text ?? "Requirements and acceptance criteria."}) Tj ET`,
    stream = (value: string) => `<< /Length ${Buffer.byteLength(value)} >>\nstream\n${value}\nendstream`,
    objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      `<< /Type /Pages /Kids [${Array.from({ length: count }, () => "3 0 R").join(" ")}] /Count ${count} >>`,
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      chinese
        ? "<< /Type /Font /Subtype /Type0 /BaseFont /Fixture /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>"
        : "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      stream(content),
    ];
  if (chinese)
    objects.push(
      "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Fixture /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 >>",
      stream(
        "/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Fixture def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange 4 beginbfchar <0001> <9700> <0002> <6C42> <0003> <6587> <0004> <6863> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end",
      ),
    );
  if (options.encrypted) {
    objects.push(`<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${"00".repeat(32)}> /U <${"00".repeat(32)}> /P -4 >>`);
    return materialPdf(objects, `/Encrypt ${objects.length} 0 R /ID [<${"01".repeat(16)}> <${"01".repeat(16)}>]`);
  }
  return materialPdf(objects);
}

export function materialOffice(kind: "docx" | "xlsx", strict = false) {
  const ns = strict
      ? "http://purl.oclc.org/ooxml/" + (kind === "docx" ? "wordprocessingml" : "spreadsheetml") + "/main"
      : "http://schemas.openxmlformats.org/" + (kind === "docx" ? "wordprocessingml" : "spreadsheetml") + "/2006/main",
    r = strict
      ? "http://purl.oclc.org/ooxml/officeDocument/relationships"
      : "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    rels = (body: string) =>
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`,
    edge = (id: string, type: string, target: string, external = false) =>
      `<Relationship Id="${id}" Type="${r}/${type}" Target="${target}"${external ? ' TargetMode="External"' : ""}/>`,
    files: Record<string, string> = {
      "[Content_Types].xml":
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>',
      "_rels/.rels": rels(edge("main", "officeDocument", "document/main.xml")),
    },
    p = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
  if (kind === "docx") {
    files["document/main.xml"] =
      `<w:document xmlns:w="${ns}"><w:body>${p("需求文档 &amp; acceptance")}<w:p><w:r><w:t>Keep</w:t><w:tab/><w:t>tab</w:t><w:br/><w:t>next line</w:t></w:r><w:del><w:r><w:delText>Deleted text</w:delText></w:r></w:del></w:p><w:tbl><w:tr><w:tc>${p("Field")}</w:tc><w:tc>${p("Required")}</w:tc></w:tr></w:tbl></w:body></w:document>`;
    files["document/_rels/main.xml.rels"] = rels(
      edge("header", "header", "header.xml") + edge("link", "hyperlink", "https://must-not-fetch.invalid/", true),
    );
    files["document/header.xml"] = `<w:hdr xmlns:w="${ns}">${p("Header text")}</w:hdr>`;
  } else {
    files["document/main.xml"] =
      `<workbook xmlns="${ns}" xmlns:r="${r}"><sheets><sheet name="产品" sheetId="1" r:id="sheet"/></sheets></workbook>`;
    files["document/_rels/main.xml.rels"] = rels(
      edge("sheet", "worksheet", "sheet.xml") + edge("strings", "sharedStrings", "strings.xml"),
    );
    files["document/strings.xml"] = `<sst xmlns="${ns}"><si><t>字段</t></si></sst>`;
    files["document/sheet.xml"] =
      `<worksheet xmlns="${ns}"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Size</t></is></c></row><row r="2"><c r="A2" t="b"><v>1</v></c><c r="B2"><f>SUM(1,2)</f><v>3</v></c></row></sheetData><mergeCells><mergeCell ref="A3:B3"/></mergeCells></worksheet>`;
  }
  return {
    files,
    ns,
    r,
    rels,
    edge,
    bytes: () =>
      zipSync(Object.fromEntries(Object.entries(files).map(([path, text]) => [path, new TextEncoder().encode(text)]))),
  };
}
