import type { StateReader, StateWriter } from "../contracts/ownership.js";
import type { StateOwner } from "../contracts/state-grants.js";
import type * as Features from "../contracts/features.js";
export interface ApplicationPorts {
  applicationProjections: Features.ApplicationProjectionsPort;
  localization: Features.LocalizationPort;
  history: Features.HistoryPort;
  queue: Features.QueuePort;
  status: Features.StatusPort;
  goals: Features.GoalsPort;
  approvals: Features.ApprovalsPort;
  models: Features.ModelsPort;
  composer: Features.ComposerPort;
  details: Features.DetailsPort;
  timing: Features.TimingPort;
  startup: Features.StartupPort;
  viewport: Features.ViewportPort;
  notices: Features.NoticesPort;
  navigation: Features.NavigationPort;
  commands: Features.CommandsPort;
  sideTasks: Features.SideTasksPort;
  turnFrames: Features.TurnFramesPort;
  connection: Features.ConnectionPort;
  timeline: Features.TimelinePort;
  transport: Features.TransportPort;
  review: Features.ReviewPort;
  activity: Features.ActivityPort;
  uploads: Features.UploadsPort;
  usage: Features.UsagePort;
  settings: Features.SettingsPort;
  account: Features.AccountPort;
  images: Features.ImagesPort;
  clipboard: Features.ClipboardPort;
  panels: Features.PanelsPort;
  bindings: Features.BindingsPort;
  diagnostics: Features.DiagnosticsPort;
  notifications: Features.NotificationsPort;
  suggestions: Features.SuggestionsPort;
  submission: Features.SubmissionPort;
  messages: Features.MessagesPort;
  environment: Features.EnvironmentPort;
  delivery: Features.DeliveryPort;
  sidebarLayout: Features.SidebarLayoutPort;
  synchronization: Features.SynchronizationPort;
  workspace: Features.WorkspacePort;
  repositories: Features.RepositoriesPort;
  inputSessions: Features.InputSessionsPort;
  identity: Features.IdentityPort;
  projects: Features.ProjectsPort;
  sidebar: Features.SidebarPort;
  workbench: Features.WorkbenchPort;
  composerInteractions: Features.ComposerInteractionsPort;
}
interface CommonOptions<O extends StateOwner = StateOwner> {
  drafts: ApplicationPorts["environment"]["drafts"];
  $: ApplicationPorts["environment"]["$"];
  configurationReadiness: ApplicationPorts["environment"]["configurationReadiness"];
  escapeHtml: ApplicationPorts["environment"]["escapeHtml"];
  i18n: ApplicationPorts["environment"]["i18n"];
  renderBatch: ApplicationPorts["environment"]["renderBatch"];
  selection: ApplicationPorts["environment"]["selection"];
  sessions: ApplicationPorts["environment"]["sessions"];
  shortPath: ApplicationPorts["environment"]["shortPath"];
  stateDomains: ApplicationPorts["environment"]["stateDomains"];
  t: ApplicationPorts["environment"]["t"];
  titleOf: ApplicationPorts["environment"]["titleOf"];
  viewUpdates: ApplicationPorts["environment"]["viewUpdates"];
  workspacePreparation: ApplicationPorts["environment"]["workspacePreparation"];
  identity: string | undefined;
  state: StateReader<O>;
  mutations: StateWriter<O>;
}
export type FeatureOptions<
  Fields extends keyof CommonOptions,
  Peers extends keyof ApplicationPorts = never,
  O extends StateOwner = StateOwner,
> = Pick<CommonOptions<O>, Fields> & { [K in Peers as `${K}Port`]: ApplicationPorts[K] };
