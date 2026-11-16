import { expect, test } from "bun:test";
import {
  closeApplicationStorage,
  drainApplicationBackground,
  startApplicationBackground,
  startApplicationIngress,
} from "../../src/server/application/lifecycle.js";

test("application shutdown drains dependents before their template sources or persistent stores", async () => {
  const events: string[] = [];
  const close = (name: string) => ({
      close: async () => {
        events.push(name);
      },
    }),
    start = (name: string) => ({
      start: () => {
        events.push(name);
      },
    }),
    stop = (name: string) => ({
      stop: () => {
        events.push(name);
      },
    });
  let release!: () => void;
  const wait = new Promise<void>((r) => {
    release = r;
  });
  const draining = drainApplicationBackground({
    cli: close("cli"),
    bots: close("bots"),
    search: close("search"),
    knowledge: close("knowledge"),
    creation: close("creation"),
    personal: close("personal"),
    publication: stop("publication"),
    editorial: stop("editorial"),
    previews: {
      close: async () => {
        events.push("preview-start");
        await wait;
        events.push("preview-end");
      },
    },
    samples: close("samples"),
    builds: close("builds"),
    themes: close("themes"),
    slides: close("slides"),
    sources: close("sources"),
    closeCreativeText: () => {
      events.push("creative");
    },
  });
  await Bun.sleep(0);
  expect(events[0]).toBe("cli");
  expect(events).not.toContain("sources");
  expect(events).not.toContain("samples");
  release();
  await draining;
  expect(events.indexOf("preview-end")).toBeLessThan(events.indexOf("builds"));
  expect(events.indexOf("samples")).toBeLessThan(events.indexOf("themes"));
  expect(events.indexOf("slides")).toBeLessThan(events.indexOf("sources"));
  const storage: string[] = [];
  const store = (name: string) => ({
    close: () => {
      storage.push(name);
    },
  });
  await closeApplicationStorage({
    drainCatalog: async () => {
      storage.push("drain");
    },
    plugins: store("plugins"),
    skills: store("skills"),
    skillWorkspace: store("skillWorkspace"),
    gadgets: store("gadgets"),
    portable: store("portable"),
    documents: store("documents"),
    catalog: store("catalog"),
    accounts: store("accounts"),
    database: store("database"),
    cluster: {
      close: (release) => {
        expect(release).toBe(true);
        storage.push("cluster");
      },
    },
  });
  expect(storage).toEqual([
    "drain",
    "plugins",
    "skills",
    "skillWorkspace",
    "gadgets",
    "portable",
    "documents",
    "catalog",
    "accounts",
    "database",
    "cluster",
  ]);
  events.length = 0;
  startApplicationBackground({
    search: start("search"),
    editorial: start("editorial"),
    creation: start("creation"),
    knowledge: start("knowledge"),
    previews: start("previews"),
    goals: start("goals"),
  });
  startApplicationIngress({
    sources: start("sources"),
    themes: start("themes"),
    slides: start("slides"),
    samples: start("samples"),
  });
  expect(events).toEqual([
    "search",
    "editorial",
    "creation",
    "knowledge",
    "previews",
    "goals",
    "sources",
    "themes",
    "slides",
    "samples",
  ]);
});
