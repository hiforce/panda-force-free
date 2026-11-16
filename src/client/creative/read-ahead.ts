import { documentTreeApi } from "../documents/authoring/tree-api.js";
import { creativeAssetsApi } from "./assets-api.js";

/** Project reads overlap optional code transfer; the mounted workspace takes ownership of the same abort controller. */
export class ProjectReadAhead {
  private current: {
    project: string;
    controller: AbortController;
    tree: ReturnType<typeof documentTreeApi.read>;
    assets: ReturnType<typeof creativeAssetsApi.list>;
    capabilities: ReturnType<typeof creativeAssetsApi.capabilities>;
  } | null = null;
  prepare(project: string) {
    if (this.current?.project === project && !this.current.controller.signal.aborted) return;
    this.cancel();
    const controller = new AbortController(),
      signal = controller.signal;
    const current = (this.current = {
      project,
      controller,
      tree: documentTreeApi.read(project, signal),
      assets: creativeAssetsApi.list(project, undefined, signal),
      capabilities: creativeAssetsApi.capabilities(project, signal),
    });
    void Promise.allSettled([current.tree, current.assets, current.capabilities]);
  }
  take(project: string) {
    const value = this.current;
    if (!value || value.project !== project || value.controller.signal.aborted) return null;
    this.current = null;
    return value;
  }
  cancel() {
    this.current?.controller.abort();
    this.current = null;
  }
}
