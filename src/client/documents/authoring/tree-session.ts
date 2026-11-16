import type { DocumentRecord } from "../../../shared/documents/contracts.js";
import type { DocumentTreeMutation, ProjectDocumentTree } from "../../../shared/documents/navigation.js";
import { validateDocumentTree } from "../../../shared/documents/navigation.js";
import type { DocumentTreePort, FrozenTreeCommand, TreeIntent } from "./tree-api.js";

export interface TreeRecovery {
  read(project: string): FrozenTreeCommand | null;
  write(project: string, command: FrozenTreeCommand | null): void;
}
function validTree(tree: ProjectDocumentTree) {
  if (
    !tree ||
    typeof tree.projectId !== "string" ||
    !Number.isSafeInteger(tree.version) ||
    tree.version < 0 ||
    !Array.isArray(tree.nodes)
  )
    throw Error("Invalid tree response");
  validateDocumentTree(tree.nodes);
  for (const node of tree.nodes)
    if (
      !node.document ||
      node.document.id !== node.documentId ||
      typeof node.document.title !== "string" ||
      typeof node.document.spaceId !== "string" ||
      !Number.isSafeInteger(node.document.revision) ||
      node.document.revision < 1
    )
      throw Error("Invalid document metadata");
}
/** One project epoch owns metadata requests; uncertain writes retain the exact command for safe replay. */
export class DocumentTreeSession {
  snapshot: ProjectDocumentTree = { projectId: "", version: 0, nodes: [] };
  pending: FrozenTreeCommand | null = null;
  busy = false;
  loading = false;
  private epoch = 0;
  private reads = 0;
  private reader: AbortController | null = null;
  constructor(
    private api: DocumentTreePort,
    private recovery: TreeRecovery,
    private changed: () => void,
  ) {}
  open(projectId: string) {
    this.reader?.abort();
    this.epoch++;
    this.reads++;
    this.busy = false;
    this.loading = false;
    this.snapshot = { projectId, version: 0, nodes: [] };
    this.pending = this.recovery.read(projectId);
    this.changed();
  }
  close() {
    this.reader?.abort();
    this.epoch++;
    this.reads++;
    this.busy = false;
    this.loading = false;
    this.snapshot = { projectId: "", version: 0, nodes: [] };
    this.pending = null;
  }
  private adopt(tree: ProjectDocumentTree) {
    validTree(tree);
    if (tree.projectId !== this.snapshot.projectId || tree.version < this.snapshot.version) return;
    const current = new Map(this.snapshot.nodes.map((node) => [node.documentId, node.document]));
    this.snapshot = {
      ...tree,
      nodes: tree.nodes.map((node) => {
        const record = current.get(node.documentId);
        return record && record.revision > node.document.revision ? { ...node, document: record } : node;
      }),
    };
    this.changed();
  }
  async refresh() {
    this.reader?.abort();
    const reader = new AbortController();
    this.reader = reader;
    const epoch = this.epoch,
      read = ++this.reads;
    this.loading = true;
    this.changed();
    try {
      const tree = await this.api.read(this.snapshot.projectId, reader.signal);
      if (epoch === this.epoch && read === this.reads && !this.busy) this.adopt(tree);
    } catch (error) {
      if (epoch === this.epoch && read === this.reads) throw error;
    } finally {
      if (epoch === this.epoch && read === this.reads) {
        this.loading = false;
        this.changed();
      }
    }
  }
  update(record: DocumentRecord) {
    this.snapshot = {
      ...this.snapshot,
      nodes: this.snapshot.nodes.map((node) =>
        node.documentId === record.id &&
        node.document.spaceId === record.spaceId &&
        record.revision >= node.document.revision
          ? { ...node, document: record }
          : node,
      ),
    };
    this.changed();
  }
  async mutate(intent: TreeIntent, treeVersion = this.snapshot.version) {
    if (this.busy || this.pending) throw Error("Resolve the pending tree operation first");
    this.pending = {
      id: crypto.randomUUID(),
      projectId: this.snapshot.projectId,
      treeVersion,
      intent: structuredClone(intent),
    };
    this.recovery.write(this.snapshot.projectId, this.pending);
    return this.retry();
  }
  async retry(): Promise<DocumentTreeMutation | null> {
    if (this.busy || !this.pending) return null;
    const epoch = this.epoch,
      command = this.pending;
    this.busy = true;
    this.reader?.abort();
    this.loading = false;
    this.reads++;
    this.changed();
    try {
      const result = await this.api.commit(command);
      validTree(result?.tree);
      if (
        result.tree.projectId !== command.projectId ||
        !result.operation ||
        result.operation.id !== command.id ||
        !Number.isSafeInteger(result.operation.treeVersion) ||
        result.operation.treeVersion > result.tree.version ||
        !Array.isArray(result.operation.affectedDocumentIds) ||
        !result.operation.affectedDocumentIds.includes(result.operation.documentId)
      )
        throw Error("Invalid operation receipt");
      if (this.recovery.read(command.projectId)?.id === command.id) this.recovery.write(command.projectId, null);
      if (epoch !== this.epoch) return null;
      this.pending = null;
      this.adopt(result.tree);
      return result;
    } catch (error) {
      if (this.api.definitive(error)) {
        if (this.recovery.read(command.projectId)?.id === command.id) this.recovery.write(command.projectId, null);
        if (epoch === this.epoch) this.pending = null;
      }
      if (epoch === this.epoch) throw error;
      return null;
    } finally {
      if (epoch === this.epoch) {
        this.busy = false;
        this.changed();
      }
    }
  }
}
