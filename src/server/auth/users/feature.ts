import { resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthState } from "../state.js";
import type { Route } from "../../http/router.js";
import { readJsonBody } from "../../http/body.js";
import { respondJson, respondError } from "../../http/respond.js";
import { requestLocale } from "../../i18n/request-locale.js";
import { matchesCookieMutationOrigin, matchesRequestOrigin } from "../origin.js";
import { localRequestIdentity } from "./identity.js";
import { LocalAccounts } from "./service.js";
import { LocalAccountMail } from "./mail.js";
import { AdministratorEmailBinding } from "./binding.js";
import { LocalPasswordRecovery } from "./reset.js";
import { MemberInvitations } from "./invitations.js";
import { AccountError, type LocalUserRepository } from "./contracts.js";
import { memberFields, memberId } from "./records.js";
import { reportDiagnostic } from "../../../shared/diagnostics.js";

/** One local account feature owns HTTP, bounded delivery scheduling and its store lifetime. */
export function createLocalAccountFeature(options: {
  repository: LocalUserRepository;
  auth: AuthState;
  stateRoot: string;
  keyPath?: string;
}) {
  const { repository, auth } = options,
    accounts = new LocalAccounts(repository, auth);
  const mail = new LocalAccountMail(
    repository,
    options.keyPath ?? resolve(options.stateRoot, "config", "local-users.key"),
  );
  const binding = new AdministratorEmailBinding(repository, mail),
    recovery = new LocalPasswordRecovery(repository, mail, auth);
  const controller = new AbortController();
  let timer: ReturnType<typeof setInterval> | undefined,
    working: Promise<void> | null = null;
  const invitations = async () => {
    await mail.initialize();
    const smtp = await mail.require();
    return new MemberInvitations(repository, mail.cipher, mail, smtp.publicUrl);
  };
  const deliver = async () => {
    if (working || controller.signal.aborted) return working;
    working = (async () => {
      if (!(await repository.settings()).smtp) return;
      const service = await invitations(),
        now = Date.now();
      const due = (await repository.list())
        .filter(
          (row) =>
            row.invitation &&
            row.invitation.delivery.nextAttemptAt <= now &&
            row.invitation.delivery.state !== "sent" &&
            row.invitation.delivery.state !== "failed" &&
            row.invitation.expiresAt > now,
        )
        .slice(0, 8);
      for (const user of due) {
        if (controller.signal.aborted) return;
        await service.deliver(user.id, controller.signal);
      }
      await binding.deliver(controller.signal);
      await recovery.deliver(controller.signal);
    })()
      .catch(() => {
        if (!controller.signal.aborted) console.warn("[local-users] Email delivery will be retried");
      })
      .finally(() => {
        working = null;
      });
    return working;
  };
  const protectedHandler =
    (work: (req: IncomingMessage, res: ServerResponse) => Promise<void>, admin = true): Route["handler"] =>
    async ({ req, res }) => {
      try {
        const principal = localRequestIdentity(req);
        if (!principal || (admin && principal.role !== "admin")) throw new AccountError("forbidden", 403);
        await work(req, res);
      } catch (error) {
        if (!(error instanceof AccountError) || error.code === "unavailable")
          reportDiagnostic("local-users.request", error);
        respondError(
          res,
          error instanceof AccountError ? error.status : 503,
          error instanceof AccountError ? error : new AccountError("unavailable", 503),
        );
      }
    };
  const publicAttempts = new Map<string, { count: number; expiresAt: number }>();
  async function publicHandle(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (
      ![
        "/api/local-users/invitation/inspect",
        "/api/local-users/invitation/accept",
        "/api/local-users/email/inspect",
        "/api/local-users/email/confirm",
        "/api/local-users/reset/request",
        "/api/local-users/reset/verify",
        "/api/local-users/reset/inspect",
        "/api/local-users/reset/accept",
      ].includes(url.pathname)
    )
      return false;
    try {
      if (req.method !== "POST") {
        respondJson(res, 405, { error: "errors.methodNotAllowed" }, { allow: "POST" });
        return true;
      }
      if (
        url.search ||
        !matchesCookieMutationOrigin(req) ||
        !matchesRequestOrigin({
          hostHeader: req.headers.host,
          origin: req.headers.origin,
          fetchSite: req.headers["sec-fetch-site"],
        })
      )
        throw new AccountError("forbidden", 403);
      const now = Date.now(),
        address = req.socket.remoteAddress ?? "unknown";
      for (const [key, item] of publicAttempts) if (item.expiresAt < now) publicAttempts.delete(key);
      let entry = publicAttempts.get(address);
      if (!entry) {
        if (publicAttempts.size >= 1024) throw new AccountError("tooManyAttempts", 429);
        publicAttempts.set(address, (entry = { count: 0, expiresAt: now + 300000 }));
      }
      if (++entry.count > 40) throw new AccountError("tooManyAttempts", 429);
      const input = await readJsonBody(req, 8192),
        locale = requestLocale(req);
      let result: unknown;
      if (url.pathname === "/api/local-users/reset/request") result = await recovery.request(input, locale);
      else if (url.pathname === "/api/local-users/reset/verify") result = await recovery.verify(input);
      else if (url.pathname === "/api/local-users/reset/accept") result = await recovery.accept(input);
      else if (url.pathname === "/api/local-users/reset/inspect")
        result = await recovery.inspect(memberFields(input, ["token"]).token);
      else if (url.pathname === "/api/local-users/email/confirm") result = await binding.confirm(input);
      else {
        const service = url.pathname.includes("/email/")
          ? new MemberInvitations(binding.repository, mail.cipher, mail, "https://localhost")
          : new MemberInvitations(repository, mail.cipher, mail, "https://localhost");
        result = url.pathname.endsWith("/accept")
          ? await service.accept(input)
          : await service.inspect(memberFields(input, ["token"]).token);
      }
      respondJson(res, 200, result);
      void deliver();
    } catch (error) {
      respondError(
        res,
        error instanceof AccountError ? error.status : 503,
        error instanceof AccountError ? error : new AccountError("unavailable", 503),
      );
    }
    return true;
  }
  const routes: Route[] = [
    {
      path: "/api/local-users/self",
      method: "GET",
      handler: protectedHandler(async (req, res) => {
        const principal = localRequestIdentity(req)!;
        respondJson(res, 200, {
          id: principal.id,
          username: principal.username,
          role: principal.role,
          ...(principal.id === "installation" ? await binding.view() : { email: principal.username, verifiedAt: true }),
          smtpConfigured: Boolean((await repository.settings()).smtp),
        });
      }, false),
    },
    {
      path: "/api/local-users/password",
      method: "POST",
      handler: protectedHandler(async (req, res) => {
        const principal = localRequestIdentity(req)!;
        if (principal.id === "installation") throw new AccountError("useEmailReset", 409);
        respondJson(res, 200, await accounts.changePassword(principal.id, await readJsonBody(req, 8192)));
      }, false),
    },
    {
      path: "/api/local-users/mail",
      method: ["GET", "PUT"],
      handler: protectedHandler(async (req, res) =>
        respondJson(
          res,
          200,
          req.method === "GET"
            ? await mail.overview()
            : await mail.save(await readJsonBody(req, 32768), AbortSignal.timeout(30000)),
        ),
      ),
    },
    {
      path: "/api/local-users/email",
      method: "POST",
      handler: protectedHandler(async (req, res) => {
        if (localRequestIdentity(req)!.id !== "installation") throw new AccountError("forbidden", 403);
        respondJson(res, 202, await binding.issue(await readJsonBody(req, 4096), requestLocale(req)));
        void deliver();
      }),
    },
    {
      path: "/api/local-users",
      method: ["GET", "POST"],
      handler: protectedHandler(async (req, res) => {
        if (req.method === "GET") {
          respondJson(res, 200, await accounts.list());
          return;
        }
        const input = await readJsonBody(req, 4096);
        if (typeof input.email === "string" && (await accounts.administratorLogin(input.email.trim().toLowerCase())))
          throw new AccountError("conflict", 409);
        const user = await (await invitations()).invite(input);
        const stored = await repository.get(user.id);
        if (stored?.invitation && !stored.invitation.locale)
          await repository.update(
            {
              ...stored,
              invitation: { ...stored.invitation, locale: requestLocale(req) },
              revision: stored.revision + 1,
            },
            stored.revision,
          );
        respondJson(res, 202, { user });
        void deliver();
      }),
    },
    {
      path: "/api/local-users/update",
      method: "POST",
      handler: protectedHandler(async (req, res) => {
        const input = memberFields(await readJsonBody(req, 4096), ["id", "revision", "role", "enabled"]);
        if (input.id === localRequestIdentity(req)!.id) throw new AccountError("selfChange", 409);
        const { id, ...fields } = input;
        respondJson(res, 200, { user: await accounts.update(id, fields) });
      }),
    },
    {
      path: "/api/local-users/resend",
      method: "POST",
      handler: protectedHandler(async (req, res) => {
        const input = memberFields(await readJsonBody(req, 4096), ["id", "revision", "operationId"]);
        respondJson(res, 202, {
          user: await (
            await invitations()
          ).resend(memberId(input.id), Number(input.revision), String(input.operationId)),
        });
        void deliver();
      }),
    },
  ];
  return {
    accounts,
    mail,
    binding,
    recovery,
    routes,
    publicHandle,
    deliver,
    start() {
      if (!timer) {
        timer = setInterval(() => void deliver(), 5000);
        timer.unref();
        void deliver();
      }
    },
    async close() {
      if (timer) clearInterval(timer);
      controller.abort();
      await working;
      await accounts.close();
    },
  };
}
