/** Owns event handlers and timers so a feature can be disposed or mounted again. */
export function createLifecycle() {
  const cleanups = new Set();
  let disposed = false;
  return {
    on(target, event, listener, options) {
      if (disposed) return;
      target.addEventListener(event, listener, options);
      cleanups.add(() => target.removeEventListener(event, listener, options));
    },
    interval(callback, milliseconds) {
      if (disposed) return;
      const timer = setInterval(callback, milliseconds);
      cleanups.add(() => clearInterval(timer));
    },
    timeout(callback, milliseconds) {
      if (disposed) return;
      const timer = setTimeout(callback, milliseconds);
      cleanups.add(() => clearTimeout(timer));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const cleanup of cleanups) cleanup();
      cleanups.clear();
    },
  };
}
