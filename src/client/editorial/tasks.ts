import type { DocumentRecord } from "../../shared/documents/contracts.js";
import type { EditorialJob, EditorialProcessingProfile } from "../../shared/editorial/jobs.js";
import { editorialApi, EditorialApiError, type EditorialApi } from "./api.js";

const activeJob = (job: EditorialJob | null) => !!job && ["queued", "running"].includes(job.state);
/** An opening owns polling and uncertain request identities. Closing the view never cancels a persisted task. */
export function createEditorialTasks(
  record: DocumentRecord,
  changed: () => void,
  failed: (error: unknown) => void,
  api: EditorialApi = editorialApi,
) {
  const state: {
    ready: boolean;
    loadError: boolean;
    configurationInvalid: boolean;
    runtimeSelection: boolean;
    profiles: EditorialProcessingProfile[];
    jobs: EditorialJob[];
    current: EditorialJob | null;
    pending: boolean;
  } = {
    ready: false,
    loadError: false,
    configurationInvalid: false,
    runtimeSelection: false,
    profiles: [],
    jobs: [],
    current: null,
    pending: false,
  };
  let open = true,
    epoch = 0,
    timer: ReturnType<typeof setTimeout> | null = null,
    submission: Parameters<typeof api.submitJob>[0] | null = null,
    retryId: string | null = null;
  function halt() {
    epoch++;
    if (timer) clearTimeout(timer);
    timer = null;
  }
  function merge(job: EditorialJob) {
    state.current = job;
    state.jobs = [job, ...state.jobs.filter((value) => value.id !== job.id)].sort(
      (a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id),
    );
    changed();
  }
  function schedule(delay = 1000) {
    if (!open || !activeJob(state.current)) return;
    const generation = epoch,
      id = state.current!.id;
    timer = setTimeout(async () => {
      timer = null;
      try {
        const { job } = await api.job(id);
        if (!open || generation !== epoch) return;
        merge(job);
      } catch (error) {
        if (!open || generation !== epoch) return;
        failed(error);
      }
      if (open && generation === epoch) schedule(1500);
    }, delay);
  }
  async function operation(work: () => Promise<{ job: EditorialJob }>, success: () => void = () => {}) {
    halt();
    const generation = epoch;
    state.pending = true;
    changed();
    try {
      const { job } = await work();
      if (!open || generation !== epoch) return;
      success();
      merge(job);
    } catch (error) {
      if (error instanceof EditorialApiError && error.status >= 400 && error.status < 500) {
        submission = null;
        retryId = null;
      }
      throw error;
    } finally {
      if (open && generation === epoch) {
        state.pending = false;
        changed();
        schedule();
      }
    }
  }
  return {
    state,
    get uncertainSubmission() {
      return submission !== null;
    },
    async load() {
      halt();
      state.ready = false;
      state.loadError = false;
      changed();
      const generation = epoch;
      const [profiles, jobs] = await Promise.all([api.processors(), api.jobs(record.id)]).catch((error) => {
        if (open && generation === epoch) {
          state.loadError = true;
          changed();
        }
        throw error;
      });
      if (!open || generation !== epoch) return;
      state.profiles = profiles.profiles;
      state.configurationInvalid = profiles.configurationInvalid;
      state.runtimeSelection = profiles.runtimeSelection === true;
      state.jobs = jobs.jobs;
      state.ready = true;
      const recovered = jobs.jobs.find((job) => job.id === submission?.id);
      if (recovered) submission = null;
      state.current = recovered || jobs.jobs.find((job) => activeJob(job)) || jobs.jobs[0] || null;
      changed();
      schedule();
    },
    select(id: string) {
      halt();
      retryId = null;
      state.current = state.jobs.find((job) => job.id === id) || null;
      changed();
      schedule();
    },
    submit(
      mode: "proofread" | "rewrite",
      profileId: string,
      selection?: import("../../shared/engine/runtime-selection.js").RuntimeSelection,
    ) {
      submission ??= {
        id: crypto.randomUUID(),
        documentId: record.id,
        revisionId: record.revisionId,
        mode,
        profileId,
        ...selection,
      };
      return operation(
        () => api.submitJob(submission!),
        () => {
          submission = null;
          retryId = null;
        },
      );
    },
    cancel() {
      const id = state.current?.id;
      return id ? operation(() => api.cancelJob(id)) : Promise.resolve();
    },
    retry() {
      const id = state.current?.id;
      if (!id) return Promise.resolve();
      retryId ??= crypto.randomUUID();
      return operation(
        () => api.retryJob(id, retryId!),
        () => {
          retryId = null;
        },
      );
    },
    close() {
      open = false;
      halt();
    },
  };
}
export type EditorialTasks = ReturnType<typeof createEditorialTasks>;
