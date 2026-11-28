interface Starts {
  start(): void;
}
interface Closes {
  close(): unknown;
}
interface Stops {
  stop(): unknown;
}
interface BackgroundWorkers {
  search: Starts;
  editorial: Starts;
  creation: Starts;
  media?: Starts;
  knowledge: Starts;
  previews: Starts;
  goals: Starts;
}
interface IngressWorkers {
  sources: Starts;
  themes: Starts;
  slides: Starts;
  samples: Starts;
}
interface BackgroundShutdown {
  originals?: Closes;
  cli: Closes;
  bots: Closes;
  search: Closes;
  knowledge: Closes;
  creation: Closes;
  media?: Closes;
  personal: Closes;
  publication: Stops;
  editorial: Stops;
  previews: Closes;
  samples: Closes;
  builds: Closes;
  themes: Closes;
  slides: Closes;
  sources: Closes;
  closeCreativeText(): unknown;
  closeMaterialText(): unknown;
}
interface StorageShutdown {
  drainCatalog(): Promise<void>;
  plugins: Closes;
  skills: Closes;
  skillWorkspace: Closes;
  gadgets: Closes;
  portable: Closes;
  documents: Closes;
  catalog: Closes;
  accounts: Closes | null;
  database: Closes;
  cluster: { close(release: boolean): unknown } | null;
}

/** Ordering is explicit: source adapters are registered before any dependent worker starts. */
export function startApplicationBackground(workers: BackgroundWorkers) {
  workers.search.start();
  workers.editorial.start();
  workers.creation.start();
  workers.media?.start();
  workers.knowledge.start();
  workers.previews.start();
  workers.goals.start();
}
export function startApplicationIngress(workers: IngressWorkers) {
  workers.sources.start();
  workers.themes.start();
  workers.slides.start();
  workers.samples.start();
}
/** Stop request-producing clients first; template workers keep their sources until dependent runs drain. */
export async function drainApplicationBackground(ports: BackgroundShutdown) {
  await Promise.all([ports.cli.close(), ports.media?.close()]);
  await Promise.all([
    ports.bots.close(),
    ports.originals?.close(),
    ports.search.close(),
    ports.closeCreativeText(),
    ports.knowledge.close(),
    (async () => {
      await Promise.all([ports.creation.close(), ports.personal.close()]);
      await ports.closeMaterialText();
    })(),
    ports.publication.stop(),
    ports.editorial.stop(),
    (async () => {
      await ports.previews.close();
      await Promise.all([ports.samples.close(), ports.builds.close()]);
      await Promise.all([ports.themes.close(), ports.slides.close()]);
      await ports.sources.close();
    })(),
  ]);
}
/** Called only after requests, engine clients and background workers have drained. Never owns the shared daemon. */
export async function closeApplicationStorage(ports: StorageShutdown) {
  await ports.drainCatalog();
  await ports.plugins.close();
  await ports.skills.close();
  await ports.skillWorkspace.close();
  await ports.gadgets.close();
  await ports.portable.close();
  await ports.documents.close();
  await ports.catalog.close();
  await ports.accounts?.close();
  await ports.database.close();
  await ports.cluster?.close(true);
}
