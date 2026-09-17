const queues = new Map<string, Promise<void>>();

/** Serialize destructive layout sagas for one desktop; other spaces remain independent. */
export function enqueueDesktopCloseMutation<T>(
  desktopId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = queues.get(desktopId) ?? Promise.resolve();
  const result = previous.catch(() => {}).then(operation);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  queues.set(desktopId, settled);
  void settled.finally(() => {
    if (queues.get(desktopId) === settled) queues.delete(desktopId);
  });
  return result;
}
