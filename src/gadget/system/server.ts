import { composerGadget } from "./composer/service.js";
import { recentGadget } from "./recent/service.js";
import { attentionGadget } from "./attention/service.js";
import { projectsGadget } from "./projects/service.js";
import { skillsGadget } from "./skills/service.js";
import { botsGadget } from "./bots/service.js";
import { creationsGadget } from "./creations/service.js";
import type { SystemGadgetPorts } from "./ports.js";
import type { GadgetRegistry } from "../../server/gadget/registry.js";
/** Composition entry: default gadgets follow the same registration contract as extensions. */
export function registerSystemGadgets(registry: GadgetRegistry, ports: SystemGadgetPorts) {
  registry.register(composerGadget(ports));
  registry.register(creationsGadget());
  registry.register(recentGadget(ports));
  registry.register(attentionGadget(ports));
  registry.register(projectsGadget(ports));
  registry.register(skillsGadget(ports));
  registry.register(botsGadget(ports));
}
