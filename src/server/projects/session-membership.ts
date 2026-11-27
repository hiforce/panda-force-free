export interface ProjectSessionCheckpoint {
  throughBytes: number;
  throughSeq: number;
}

export interface ProjectSessionMembership {
  projectId: string;
  checkpoint: ProjectSessionCheckpoint | null;
}

export interface ProjectSessionBinding {
  id: string;
  name?: string;
  preview?: string;
  cwd?: string;
  updatedAt?: number;
  checkpoint?: ProjectSessionCheckpoint;
}
