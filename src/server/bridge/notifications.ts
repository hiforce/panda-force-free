import { engineEnvelope as nativeEnvelope } from "../../shared/engine/events.js";
import type {
  EngineEnvelope as NativeEnvelope,
  EngineEventParameters as NativeNotificationParams,
} from "../../shared/engine/contracts.js";
type NotificationHandler = (params: NativeNotificationParams, message: NativeEnvelope) => void;

/**
 * Registry for app-server notification side effects. Replaces the probing
 * if-chain in the bridge: each concern registers for the methods it cares
 * about, and new notification types never touch the dispatch code.
 */
export function createNotificationRegistry() {
  const byMethod = new Map<string, NotificationHandler[]>();
  const observers: Array<(message: NativeEnvelope) => void> = [];
  return {
    on(methods: string | string[], handler: NotificationHandler) {
      for (const method of Array.isArray(methods) ? methods : [methods]) {
        const handlers = byMethod.get(method) || [];
        handlers.push(handler);
        byMethod.set(method, handlers);
      }
    },
    onAny(handler: (message: NativeEnvelope) => void) {
      observers.push(handler);
    },
    dispatch(input: unknown) {
      const message = nativeEnvelope(input);
      for (const handler of observers) handler(message);
      for (const handler of byMethod.get(message.method || "") || []) handler(message.params ?? {}, message);
    },
  };
}
