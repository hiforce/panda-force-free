export function createFilePreview(options = {}) {
  let instance = null,
    loading = null,
    version = 0,
    pending = false;
  const load = () =>
    (loading ||= import("/file-preview.bundle.js")
      .then((module) => (instance = module.createFilePreview(options)))
      .catch((error) => {
        loading = null;
        throw error;
      }));
  const preview = {
    get isOpen() {
      return pending || Boolean(instance?.isOpen);
    },
    async open(reference) {
      const current = ++version;
      pending = true;
      try {
        const viewer = instance || (await load());
        if (current === version) await viewer.open(reference);
      } catch (error) {
        options.onError?.(error);
      } finally {
        if (current === version) pending = false;
      }
    },
    close() {
      version++;
      pending = false;
      instance?.close();
    },
  };
  return preview;
}
