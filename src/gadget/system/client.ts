import { register as composer } from "./composer/client.js";
import { register as recent } from "./recent/client.js";
import { register as attention } from "./attention/client.js";
import { register as projects } from "./projects/client.js";
import { register as skills } from "./skills/client.js";
import { register as bots } from "./bots/client.js";
import { register as creations } from "./creations/client.js";
import { ClientGadgetRegistry } from "../../client/gadget/contracts.js";
export function registerSystemGadgetComponents(registry: ClientGadgetRegistry) {
  for (const register of [composer, creations, recent, attention, projects, skills, bots]) register(registry);
}

export function systemGadgetRegistry() {
  const registry = new ClientGadgetRegistry();
  registerSystemGadgetComponents(registry);
  return registry;
}
