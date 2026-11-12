// This reserved application context travels with native input, including queued turns.
export function stripAttachmentWorkspaceContext(text) {
  return String(text || "").replace(
    /(?:^|\n)<panda_attachment_workspace>\n[\s\S]*?\n<\/panda_attachment_workspace>(?:\n|$)/g,
    "",
  );
}

// Native previews and older sidebar caches may truncate the reserved context block.
export function stripAttachmentWorkspacePreview(text) {
  return stripAttachmentWorkspaceContext(text).replace(/(?:^|\n)<panda_attachment_workspace>(?:\n|$)[\s\S]*$/, "");
}

export function attachmentWorkspaceContext({ input, work, output, marker, markerId }) {
  return `<panda_attachment_workspace>
PandaForce application context: downloads are served by the PandaForce web service, which may run in a container with a different filesystem from your execution tools. A file existing in your execution environment alone does not make it downloadable. Use these shared attachment directories for this session.
Input directory: ${JSON.stringify(input)}
Processing directory: ${JSON.stringify(work)}
Output directory: ${JSON.stringify(output)}
Shared workspace marker: ${JSON.stringify(marker)}; expected id: ${JSON.stringify(markerId)}
Before processing attachments, read the existing workspace marker and verify its id. If it is missing or different, report that the engine and web service do not share this workspace; do not create a replacement marker or promise a download from a private filesystem.
Preserve uploaded originals. Use the processing directory for intermediate files and the output directory for generated deliverables, unless the user specifies another shared workspace location. Ordinary repository edits stay in their intended project paths.
Files created outside the shared workspace by tools must be copied into the output directory before delivery. Do not assume /mnt/data, a container's /tmp, or a sandbox: prefix makes a file available to PandaForce.
Before returning an attachment, verify that the output exists. Link to its absolute workspace path and preserve the original filename where possible.
</panda_attachment_workspace>`;
}

export function unavailableAttachmentWorkspaceContext() {
  return `<panda_attachment_workspace>
PandaForce could not prepare a validated, writable shared attachment directory for this session. Conversation and ordinary repository work can continue. Before processing or delivering attachments, resolve the working-directory access or shared-mount configuration. Do not substitute /mnt/data or a private temporary directory and promise a downloadable file.
</panda_attachment_workspace>`;
}
