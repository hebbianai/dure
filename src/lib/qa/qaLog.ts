export function qaLog(...args: unknown[]) {
  try {
    fetch("/__qa_log", {
      method: "POST",
      body: JSON.stringify(
        args.map((arg) =>
          arg instanceof Error ? `${arg.message}\n${arg.stack}` : arg,
        ),
      ),
    }).catch(() => {});
  } catch {
    /* noop */
  }
}
