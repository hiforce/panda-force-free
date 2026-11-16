import type { BuildArtifact } from "../../../shared/builds/contracts.js";
import type { SitePublicationPlan } from "../../../shared/delivery/contracts.js";
import type { RemoteSite } from "../../../shared/connections/remote-files.js";
import { RemoteFileError } from "../../../shared/connections/remote-files.js";
import type { PublicationGate, SiteDeliveryAdapter } from "../ports.js";
import { DeliveryError, PublicationEffectError } from "../errors.js";
import { remoteCurrent, remoteLock, lockToken, verifyRemoteRelease } from "./remote-state.js";
import { uploadRemoteRelease } from "./remote-upload.js";

function code(error: unknown) {
  if (error instanceof DeliveryError) return error.code;
  if (error instanceof RemoteFileError)
    return error.code === "remoteLimit"
      ? "remoteTargetQuota"
      : "remote" + error.code[0]!.toUpperCase() + error.code.slice(1);
  return "remoteConnectionFailed";
}
/** Remote leases cannot fence a dispatched request. Recovery observes first and never replays activation. */
export class SftpSiteDelivery implements SiteDeliveryAdapter {
  readonly recovery = "inspect-only" as const;
  constructor(private connect: () => Promise<RemoteSite>) {}
  async reconcile(plan: SitePublicationPlan, artifact: BuildArtifact) {
    const site = await this.connect();
    try {
      if ((await remoteCurrent(site, plan.servedPath)) !== plan.id) return null;
      const receipt = await verifyRemoteRelease(site, plan, artifact);
      return (await remoteLock(site)) === null ? receipt : null;
    } catch (error) {
      throw new PublicationEffectError(code(error), "unknown");
    } finally {
      site.close();
    }
  }
  async recover(plan: SitePublicationPlan, artifact: BuildArtifact, gate: PublicationGate) {
    const site = await this.connect();
    try {
      if ((await remoteCurrent(site, plan.servedPath)) !== plan.id)
        throw new PublicationEffectError("remoteOutcomeUnresolved", "unknown");
      const receipt = await verifyRemoteRelease(site, plan, artifact),
        lock = await remoteLock(site);
      if (lock !== null) {
        if (lock !== lockToken(plan)) throw new PublicationEffectError("remoteLocked", "unknown");
        await gate.remote("activating", "recoverLock", () => site.files.unlink(site.path + "/.panda-publish.lock"));
      }
      return receipt;
    } catch (error) {
      throw new PublicationEffectError(code(error), "unknown");
    } finally {
      site.close();
    }
  }
  async deliver(plan: SitePublicationPlan, artifact: BuildArtifact, gate: PublicationGate) {
    let site: RemoteSite | undefined,
      lockAcquired = false,
      lockAttempted = false,
      activationAttempted = false;
    try {
      site = await this.connect();
      const remote = site;
      await gate.remote("staging", "probeTarget", () => remote.probe());
      if ((await remoteLock(site)) !== null) throw new DeliveryError("remoteLocked", 409);
      lockAttempted = true;
      // A symlink atomically records the owner while refusing to replace an existing lock.
      await gate.remote("staging", "acquireLock", () =>
        remote.files.symlink(lockToken(plan), remote.path + "/.panda-publish.lock"),
      );
      lockAcquired = true;
      const previous = await remoteCurrent(site, plan.servedPath);
      if (previous === plan.id) throw new DeliveryError("remoteOutcomeUnresolved", 409);
      const receipt = await uploadRemoteRelease(site, plan, artifact, previous, gate);
      if ((await remoteCurrent(site, plan.servedPath)) !== previous || (await remoteLock(site)) !== lockToken(plan))
        throw new DeliveryError("remoteTargetChanged", 409);
      const next = site.path + "/.current-" + plan.id;
      await gate.remote("staging", "prepareLink", () => remote.files.symlink(`releases/${plan.id}/site`, next));
      activationAttempted = true;
      await gate.remote("activating", "activateRelease", () =>
        remote.files.atomicRename(next, remote.path + "/current"),
      );
      if ((await remoteCurrent(site, plan.servedPath)) !== plan.id)
        throw new DeliveryError("remoteOutcomeUnresolved", 409);
      await gate.remote("activating", "releaseLock", () => remote.files.unlink(remote.path + "/.panda-publish.lock"));
      return receipt;
    } catch (error) {
      if (error instanceof DeliveryError && error.code === "leaseLost") throw error;
      if (!lockAttempted) throw new PublicationEffectError(code(error), "unchanged");
      if (site && lockAcquired && !activationAttempted) {
        let released = false;
        try {
          const remote = site;
          if ((await remoteLock(site)) === lockToken(plan)) {
            await gate.remote("staging", "releaseFailedTransfer", () =>
              remote.files.unlink(remote.path + "/.panda-publish.lock"),
            );
            released = true;
          }
        } catch {
          // A missing cleanup acknowledgement leaves ownership unresolved.
        }
        if (released) throw new PublicationEffectError(code(error), "unchanged");
      }
      throw new PublicationEffectError(code(error), "unknown");
    } finally {
      site?.close();
    }
  }
}
