export interface RolloutPayload {
  type: string;
  turn_id?: string;
  started_at?: number;
  completed_at?: number;
  id?: string;
  call_id?: string;
  client_id?: string;
  role?: string;
  phase?: string;
  name?: string;
  message?: string;
  input?: unknown;
  output?: unknown;
  content?: unknown;
  summary?: unknown;
  arguments?: unknown;
  local_images?: string[];
  images?: string[];
  changes?: Record<string, { type?: string; move_path?: string | null; unified_diff?: string; content?: string }>;
  success?: boolean;
  status?: string;
  stderr?: string;
  stdout?: string;
}
export interface RolloutEvent {
  type: string;
  timestamp?: string;
  payload: RolloutPayload;
}
