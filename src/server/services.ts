import type {
  IdentityAuth,
  ObjectAttachmentStorage,
  ImageThumbnail,
  EngineConnection,
  AccountLoader,
  ProjectVisibilityRepository,
  ProjectRepository,
} from "./contracts/runtime.js";
import type { SessionHistory, EngineGoals, EngineRecovery } from "./engines/runtime-contract.js";
import type { ClusterWorker } from "./cluster/worker.js";
import type { ServerResponse } from "node:http";
import type { WebSocket } from "ws";
import type { EngineEnvelope, EngineDriver } from "../shared/engine/contracts.js";
import type { ReviewDiffStore } from "./review/state.js";

export interface RuntimeServices {
  browserWire: import("./bridge/browser-wire.js").BrowserWire;
  watchPasswordSession?: (request: import("node:http").IncomingMessage, onRevoke: () => void) => () => void;
  cluster?: ClusterWorker | null;
  appRoot: string;
  homeDir: string;
  defaultCwd: string;
  attachmentRoot: string;
  projectless: boolean;
  browseRoots: string[];
  imageRoots: string[];
  fileRoots: string[];
  reviewRoots: string[];
  idaasAuth: IdentityAuth | null;
  attachmentStorage: ObjectAttachmentStorage | null;
  imageThumbnail: ImageThumbnail;
  appServerConnection: EngineConnection;
  projectVisibility: ProjectVisibilityRepository;
  projectCatalog: ProjectRepository;
  goalStore: EngineGoals;
  reviewDiffs: ReviewDiffStore;
  clients: Set<WebSocket>;
  sseClients: Set<ServerResponse>;
  pendingEngineRequests: Map<number | string, EngineEnvelope>;
  engineDriver: Pick<EngineDriver, "connected" | "descriptor">;
  threadHub: SessionHistory;
  accountLoader: AccountLoader;
  autoContinueRecovery: EngineRecovery;
  recoverMessageQueue: (id: unknown) => Promise<unknown>;
  request: import("../shared/rpc-types.js").RpcRequest;
  sendRaw: (message: object) => void;
  broadcast: (message: object) => void;
  presentBrowserData: <T>(value: T) => T;
  dispatchBrowserMessage: (message: unknown) => Promise<unknown>;
  encodeContentDispositionFilename: (filename: string) => string;
}
