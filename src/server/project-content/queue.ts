import { ProjectContentError } from "./errors.js";

interface ProjectQueue {
  tail: Promise<void>;
  size: number;
}
const queues = new Map<string, ProjectQueue>();

/** Owner-specific adapters share bounded physical exclusion, while retaining their own authorization callbacks. */
export async function queueProjectContent<T>(directory: string, work: () => Promise<T>): Promise<T> {
  let queue = queues.get(directory);
  if (!queue) {
    if (queues.size >= 512) throw new ProjectContentError("unavailable");
    queue = { tail: Promise.resolve(), size: 0 };
    queues.set(directory, queue);
  }
  if (queue.size >= 64) throw new ProjectContentError("unavailable");
  queue.size++;
  const previous = queue.tail;
  let release: () => void = () => {};
  queue.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await work();
  } finally {
    queue.size--;
    release();
    if (queue.size === 0 && queues.get(directory) === queue) queues.delete(directory);
  }
}
