import { sourcePath } from "../../../shared/packages/sources/paths.js";
import { stageId } from "../../../shared/packages/stages/input.js";
import { SourceStageError } from "../../../shared/packages/stages/contracts.js";
import { templateDigest, templateObject } from "../../../shared/templates/portable/validation.js";
import type { TemplateSourceReader, TemplateSourceConsumer } from "./ports.js";
import { PortableTemplateSource } from "../portable/source.js";
import { portableInstallApproval } from "../portable/commands.js";
import type { PortableTemplateInstallation } from "../portable/installation.js";

function reference(input: Record<string, unknown>) {
  return Object.freeze({
    id: stageId(input.id),
    sha256: templateDigest(input.sha256),
    root: input.root === "" ? "" : sourcePath(input.root),
  });
}
/** Review is read-only; installation accepts immutable bytes before entering the registry command authority. */
export class SourceTemplateImport {
  constructor(
    private reader: TemplateSourceReader,
    private consumer: TemplateSourceConsumer,
    private installation: PortableTemplateInstallation,
  ) {}
  review(actor: string, input: unknown) {
    const command = templateObject(input, ["id", "sha256", "root", "selected"]),
      source = reference(command),
      selected = Array.isArray(command.selected) ? [...command.selected] : command.selected;
    return this.reader.project(actor, source.id, async (value) => {
      if (value.digest !== source.sha256) throw new SourceStageError("stageConflict");
      return this.installation.review(await PortableTemplateSource.captured(value, source.root), selected);
    });
  }
  async install(actor: string, input: unknown) {
    const command = templateObject(input, ["id", "sha256", "root", "approval"]),
      source = reference(command),
      approval = portableInstallApproval(command.approval),
      replay = await this.installation.replayCaptured(actor, source.sha256, source.root, approval);
    if (replay) return replay;
    return this.consumer.consume(actor, source.id, source.sha256, async (value) =>
      this.installation.install(await PortableTemplateSource.captured(value, source.root), approval, actor),
    );
  }
}
