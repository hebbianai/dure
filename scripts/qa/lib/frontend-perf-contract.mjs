const MAX_PAGE_ERROR_DIAGNOSTIC_LENGTH = 4_000;

export function formatPageError(error) {
  const message =
    typeof error?.message === "string" && error.message.length > 0
      ? error.message
      : String(error);
  const stack = typeof error?.stack === "string" ? error.stack : "";
  const diagnostic =
    stack.length > 0 && stack.includes(message)
      ? stack
      : [message, stack].filter(Boolean).join("\n");
  return diagnostic.slice(0, MAX_PAGE_ERROR_DIAGNOSTIC_LENGTH);
}

export function assertFrontendPerformanceResult(results) {
  const pageErrors = Array.isArray(results?.pageErrorSample)
    ? results.pageErrorSample
    : [];
  if (pageErrors.length > 0) {
    throw new Error(
      `Frontend performance run captured ${pageErrors.length} unexpected page error(s):\n${pageErrors.join("\n---\n")}`,
    );
  }

  if ((results?.remountCost?.count ?? 0) === 0) {
    throw new Error(
      "Frontend performance run did not capture a cold remountCost sample; keep the first desktop-switch dwell long enough for terminal hydration.",
    );
  }

  const missingJourneys = [
    ["initial workspace", results?.journeys?.initialWorkspace?.workspacePaint],
    ["first visit", results?.journeys?.firstVisit?.workspacePaint],
    ["revisit", results?.journeys?.revisit?.workspacePaint],
  ].filter(([, metric]) => (metric?.count ?? 0) === 0);
  if (missingJourneys.length > 0) {
    throw new Error(
      `Frontend performance run did not capture: ${missingJourneys
        .map(([name]) => name)
        .join(", ")}`,
    );
  }

  if ((results?.paneFocus?.paint?.count ?? 0) === 0) {
    throw new Error("Frontend performance run did not capture a pane-focus paint sample");
  }
}
