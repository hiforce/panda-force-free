export interface GadgetRow {
  id: string;
  title: string;
  description?: string;
  status?: string;
  updatedAt?: number;
  cover?: string;
  version?: string;
}
export interface SystemGadgetPorts {
  authorize(owner: string, capability: string): boolean | Promise<boolean>;
  sessions(owner: string, limit: number): Promise<GadgetRow[]>;
  attention(owner: string, limit: number): Promise<GadgetRow[]>;
  projects(owner: string, limit: number): Promise<GadgetRow[]>;
  skills(owner: string, limit: number): Promise<GadgetRow[]>;
  bots(owner: string): Promise<unknown>;
}
