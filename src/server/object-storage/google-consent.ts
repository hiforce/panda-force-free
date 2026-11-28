import { createHash, randomUUID } from "node:crypto";
import { googleStorageCallbackPath } from "../../shared/workspace-tools/storage.js";
import type { SecretEnvelope } from "../connections/credentials/ports.js";
import { OAuthHttp } from "../connections/oauth/http.js";
import { createPkce } from "../connections/oauth/pkce.js";
import { invalidRegistration, registrationFields, type StorageRegistration } from "./registration.js";

const lifetime = 10 * 60_000;
const statePattern = /^(\d{13})-([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/;
const driveScope = "https://www.googleapis.com/auth/drive.file";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
interface Attempt {
  browser: string;
  id: string;
  name: string;
  redirectUri: string;
  state: string;
  secret: SecretEnvelope;
}
function googleValue(value: unknown, limit = 8192) {
  if (typeof value !== "string" || !value || value.length > limit || /[^\x21-\x7e]/.test(value))
    return invalidRegistration();
  return value;
}
export class GoogleStorageConsent {
  constructor(
    private readonly storage: StorageRegistration,
    private readonly http = new OAuthHttp(),
  ) {}
  async begin(input: unknown, origin: string, browserToken: string) {
    const { id, name, field } = registrationFields(input);
    const clientId = field("clientId", 256),
      clientSecret = field("clientSecret", 512),
      url = new URL(origin);
    if (!/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(clientId) || !/^[\x21-\x7e]+$/.test(clientSecret))
      return invalidRegistration();
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    )
      return invalidRegistration();
    const now = Date.now(),
      { state, verifier, challenge } = createPkce(),
      key = now + "-" + randomUUID(),
      redirectUri = new URL(googleStorageCallbackPath, url.origin).href;
    const attempt: Attempt = {
      id,
      name,
      redirectUri,
      state: digest(state),
      browser: digest(browserToken),
      secret: await this.storage.cipher.seal(this.storage.binding(id, "google-drive-consent"), {
        clientId,
        clientSecret,
        verifier,
      }),
    };
    for (const folder of ["google-consents", "google-consents-used"]) {
      const expired = (await this.storage.files.list([folder])).filter(
        (entry) => Number(entry.split("-")[0]) < now - lifetime,
      );
      for (const entry of expired.slice(0, 32)) await this.storage.files.remove([folder, entry]);
    }
    if (!(await this.storage.files.writeOnce(["google-consents", key + ".json"], attempt)))
      return invalidRegistration();
    const consent = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    consent.search = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      scope: driveScope,
      redirect_uri: redirectUri,
      state: key + "." + state,
      access_type: "offline",
      prompt: "consent",
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    return consent.href;
  }
  async finish(query: URLSearchParams, host: string | undefined, browserToken: string) {
    const state = statePattern.exec(query.get("state") ?? "");
    if (!state || Number(state[1]) < Date.now() - lifetime || Number(state[1]) > Date.now()) return "expired";
    const name = state[1] + "-" + state[2] + ".json",
      attempt = (await this.storage.files.read(["google-consents", name])) as Attempt | null;
    if (
      !attempt ||
      attempt.browser !== digest(browserToken) ||
      attempt.state !== digest(state[3]!) ||
      new URL(attempt.redirectUri).host.toLowerCase() !== host?.toLowerCase()
    )
      return "expired";
    if (!(await this.storage.files.writeOnce(["google-consents-used", name], { used: true }))) return "expired";
    if (query.get("error")) return query.get("error") === "access_denied" ? "cancelled" : "failed";
    try {
      const code = googleValue(query.get("code"));
      const { clientId, clientSecret, verifier } = await this.storage.cipher.open(
        this.storage.binding(attempt.id, "google-drive-consent"),
        attempt.secret,
      );
      const token = await this.http.request("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: googleValue(clientId),
          client_secret: googleValue(clientSecret),
          code,
          code_verifier: googleValue(verifier),
          redirect_uri: attempt.redirectUri,
          grant_type: "authorization_code",
        }),
      });
      if (typeof token.scope === "string" && !token.scope.split(/\s+/).includes(driveScope)) return "failed";
      const refreshToken = googleValue(token.refresh_token);
      const info = await this.http.request("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)", {
        headers: { authorization: "Bearer " + googleValue(token.access_token) },
      });
      const account =
        info.user && typeof info.user === "object" && "emailAddress" in info.user
          ? googleValue(info.user.emailAddress, 320)
          : invalidRegistration();
      await this.storage.save(
        { id: attempt.id, provider: "google-drive", name: attempt.name, account },
        { clientId, clientSecret, refreshToken, scope: driveScope },
      );
      return "saved";
    } catch {
      return "failed";
    }
  }
}
