// Each generation owns its timer and request. Resetting a poller invalidates
// old results and finalizers without cancelling shared transport requests.
export function createSerialPoller({
  read,
  enabled = () => true,
  interval,
  hiddenInterval = interval,
  isHidden = () => document.visibilityState === "hidden",
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let generation = 0,
    timer = null,
    inFlight = null;
  function cancelTimer() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }
  function schedule(delay = interval) {
    cancelTimer();
    if (!enabled()) return;
    timer = setTimer(
      () => {
        timer = null;
        void run();
      },
      isHidden() ? Math.max(delay, hiddenInterval) : delay,
    );
  }
  async function run() {
    cancelTimer();
    if (!enabled()) return;
    if (inFlight) {
      schedule();
      return;
    }
    const request = { generation };
    inFlight = request;
    const current = () => generation === request.generation && enabled();
    let next = interval;
    try {
      next = (await read(current)) ?? interval;
    } finally {
      if (inFlight === request) inFlight = null;
      if (current()) schedule(next);
    }
  }
  function reset() {
    generation++;
    cancelTimer();
    inFlight = null;
  }
  return {
    run,
    schedule,
    reset,
    get pending() {
      return Boolean(inFlight);
    },
  };
}
