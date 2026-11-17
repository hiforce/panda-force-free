import { expect, test } from "bun:test";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { creationAppFixture } from "../support/creation-app.js";
import { materialOffice, textPdf } from "../support/material-text.js";
import { officeFixture } from "../support/office-presentation.js";
import type { CreationMaterial } from "../../src/shared/creation/contracts.js";

test("real uploads feed paged PDF and Office text into the creation tool while retaining original downloads and owner/digest fences", async () => {
  const f = await creationAppFixture(),
    word = materialOffice("docx"),
    source = "Full source line. ".repeat(600) + "终点😀",
    originals = new Map<string, Uint8Array>([
      ["requirements.pdf", textPdf({ chinese: true })],
      ["requirements.docx", word.bytes()],
      ["fields.xlsx", materialOffice("xlsx").bytes()],
      ["slides.pptx", officeFixture({ slides: 2 }).bytes()],
      ["large.txt", Buffer.from(source)],
    ]),
    materials: CreationMaterial[] = [];
  let observed: Record<string, string> = {};
  try {
    for (const [name, bytes] of originals) {
      const upload = await f.files.raw("/api/creation-materials?" + new URLSearchParams({ name }), "POST", bytes);
      expect(upload.status).toBe(201);
      const { attachment } = await upload.json();
      const [material] = await f.materials.prepare("operator:test-user", [{ materialId: attachment.materialId }]);
      materials.push(material!);
      const original = await f.files.raw(attachment.url);
      expect(original.status).toBe(200);
      expect(original.headers.get("cache-control")).toBe("private, no-store");
      expect(new Uint8Array(await original.arrayBuffer())).toEqual(new Uint8Array(bytes));
    }
    f.onRun(async (_input, callbacks, scope) => {
      const context = JSON.parse(
        (await callbacks.call({ ...scope, callId: randomUUID(), name: "panda_creation_context", arguments: {} })).text,
      );
      expect(context.materials).toHaveLength(5);
      const result: Record<string, string> = {};
      for (const material of context.materials) {
        let offset: number | null = 0,
          text = "";
        do {
          const response = await callbacks.call({
            ...scope,
            callId: randomUUID(),
            name: "panda_creation_material_read",
            arguments: { id: material.id, offset },
          });
          expect(response.success).toBe(true);
          const page = JSON.parse(response.text);
          expect(page.offset).toBe(offset);
          expect(page.content.length).toBeLessThanOrEqual(4000);
          text += page.content;
          offset = page.nextOffset;
          if (offset !== null) expect(offset).toBe(text.length);
        } while (offset !== null);
        result[material.name] = text;
      }
      observed = result;
      await f.save(callbacks, scope, "Read supplied Word, Excel, PDF, slides and complete long text.");
    });
    const availability = (await f.files.call("/api/document-creations/options")).body,
      id = randomUUID(),
      accepted = await f.files.call("/api/document-creations", "POST", {
        id,
        projectId: "project-1",
        treeVersion: 0,
        parentId: null,
        locale: "zh-TW",
        prompt: "根據所有附件整理需求。",
        profileId: "codex",
        selections: [availability.defaultWorkflow],
        attachments: materials.map((m) => ({ materialId: m.id })),
      });
    expect(accepted.status).toBe(202);
    await f.until(id, (task) => task.state === "succeeded");
    expect(observed["requirements.pdf"]).toBe("需求文档");
    expect(observed["requirements.docx"]).toContain("Field\tRequired");
    expect(observed["fields.xlsx"]).toContain('"value":"字段"');
    expect(observed["slides.pptx"]).toContain("Hello world\nNext line");
    expect(observed["large.txt"]).toBe(source);
    const pdf = materials[0]!;
    await expect(f.materials.read("operator:other", pdf)).rejects.toThrow();
    f.actor("operator:other");
    expect((await f.files.raw("/api/creation-materials/original?id=" + pdf.id)).status).toBe(404);
    f.actor("operator:test-user");
    await expect(f.materials.read("operator:test-user", { ...pdf, name: "borrowed.pdf" })).rejects.toMatchObject({
      code: "conflict",
    });
    const path = join(
        f.root,
        "materials",
        createHash("sha256").update("operator:test-user").digest("hex"),
        "data",
        pdf.id,
        pdf.name,
      ),
      bytes = await readFile(path);
    await writeFile(path, Buffer.from("Different bytes after cached extraction"));
    await expect(f.materials.read("operator:test-user", pdf)).rejects.toMatchObject({ code: "conflict" });
    await writeFile(path, bytes);
    expect(JSON.parse((await f.materials.read("operator:test-user", pdf)).text).content).toBe("需求文档");
    await expect(f.materials.read("operator:test-user", pdf, 1000)).rejects.toMatchObject({ code: "invalidInput" });
  } finally {
    await f.close();
  }
}, 60000);

test("material failures are localized through the execution locale, preserve bytes and never become document source", async () => {
  const f = await creationAppFixture();
  try {
    const attachments: { materialId: string }[] = [];
    for (const [name, bytes] of [
      ["broken.pdf", Buffer.from("Corrupt PDF")],
      ["locked.pdf", textPdf({ encrypted: true })],
      ["scan.pdf", textPdf({ text: "" })],
      ["old.doc", Buffer.from("Old binary")],
      ["bad.txt", Buffer.from([255, 0])],
    ] as const) {
      const upload = await f.files.raw("/api/creation-materials?" + new URLSearchParams({ name }), "POST", bytes);
      expect(upload.status).toBe(201);
      const { attachment } = await upload.json();
      attachments.push({ materialId: attachment.materialId });
    }
    const materials = await f.materials.prepare("operator:test-user", attachments);
    for (const locale of ["en", "zh-CN", "zh-HK", "zh-TW"]) {
      const result = await f.materials.read("operator:test-user", materials[1]!, 0, locale),
        error = JSON.parse(result.text);
      expect(result.success).toBe(false);
      expect(error.code).toBe("encrypted");
      expect(error.messageId).toBe("creation.materialEncrypted");
      expect(error.retryable).toBe(false);
      expect(error.message).toContain(
        locale === "en" ? "password" : locale === "zh-CN" ? "上传" : locale === "zh-HK" ? "上載" : "上傳",
      );
    }
    const readiness = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const errors: string[] = [];
    f.onRun(async (_input, callbacks, scope) => {
      try {
        for (const material of materials) {
          const result = await callbacks.call({
              ...scope,
              callId: randomUUID(),
              name: "panda_creation_material_read",
              arguments: { id: material.id },
            }),
            error = JSON.parse(result.text);
          expect(result.success).toBe(false);
          expect(error.message).toMatch(/\p{Script=Han}/u);
          if (error.code === "encrypted") expect(error.message).toContain("上傳");
          expect(error).not.toHaveProperty("content");
          errors.push(error.code);
        }
        readiness.resolve();
        await release.promise;
      } catch (error) {
        readiness.reject(error);
        throw error;
      }
    });
    const options = (await f.files.call("/api/document-creations/options")).body,
      id = randomUUID();
    try {
      expect(
        (
          await f.files.call("/api/document-creations", "POST", {
            id,
            projectId: "project-1",
            treeVersion: 0,
            parentId: null,
            locale: "zh-TW",
            prompt: "讀取附件",
            profileId: "codex",
            selections: [options.defaultWorkflow],
            attachments,
          })
        ).status,
      ).toBe(202);
      await readiness.promise;
      expect(errors).toEqual(["unreadable", "encrypted", "empty", "unsupported", "unreadable"]);
      expect((await f.files.application().navigation.tree("project-1")).nodes).toHaveLength(0);
    } finally {
      release.resolve();
    }
  } finally {
    await f.close();
  }
}, 60000);
