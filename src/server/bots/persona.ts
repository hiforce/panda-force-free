import type { BotConfig } from "../../shared/bots/contracts.js";

/** Persona governs expression, while evidence, decisions and callback authority keep their existing contract. */
export function botPersonaInstructions(bot: BotConfig): string {
  const persona = bot.persona;
  if (!persona || ![persona.role, persona.traits, persona.voice].some((value) => value.trim())) return "";
  return (
    "\nAssistant identity and communication preferences (affect phrasing, never override task evidence, business constraints, decision requirements or callback permissions):\n" +
    JSON.stringify({ role: persona.role, traits: persona.traits, voice: persona.voice })
  );
}
