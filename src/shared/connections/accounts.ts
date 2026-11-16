/** Social accounts have platform identities, not filesystem publication targets. */
export interface SocialAccount {
  id: string;
  projectId: string;
  name: string;
  provider: "x";
  version: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  application: { clientId: string; callbackUrl: string; confidential: boolean };
  /** Derived credential health; never includes tokens or encryption metadata. */
  authorizationState?: "ready" | "refreshing" | "reauthorizationRequired" | "unconnected";
  account?: { id: string; username: string; name: string };
  grant?: { expiresAt: number; scopes: string[]; credentialRevision: number };
}
export interface SocialAccountInput {
  id: string;
  projectId: string;
  name: string;
  provider: "x";
  application: { clientId: string; clientSecret?: string; callbackUrl: string };
}
export type SocialAccountUpdate = Pick<SocialAccountInput, "name"> & {
  version: number;
  enabled: boolean;
  application?: SocialAccountInput["application"];
};

export type AccountAuthorizationPhase = "preparing" | "prepared" | "exchanging" | "verifying" | "complete" | "failed";
export interface AccountAuthorization {
  id: string;
  connectionId: string;
  phase: AccountAuthorizationPhase;
  expiresAt: number;
}
