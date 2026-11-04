type NotificationHandler = (params: any, message: any) => void;

/**
 * Registry for app-server notification side effects. Replaces the probing
 * if-chain in the bridge: each concern registers for the methods it cares
 * about, and new notification types never touch the dispatch code.
 */
export function createNotificationRegistry() {
  const byMethod = new Map<string, NotificationHandler[]>();
  const any: Array<(message: any) => void> = [];
  return {
    on(methods: string | string[], handler: NotificationHandler) {
      for (const method of Array.isArray(methods) ? methods : [methods]) {
        const handlers = byMethod.get(method) || [];
        handlers.push(handler);
        byMethod.set(method, handlers);
      }
    },
    onAny(handler: (message: any) => void) {
      any.push(handler);
    },
    dispatch(message: any) {
      for (const handler of any) handler(message);
      for (const handler of byMethod.get(message.method) || []) handler(message.params ?? {}, message);
    },
  };
}
