export const TERMINAL_SURFACE_SELECTORS = Object.freeze({
  host: ".terminal-host",
  input:
    '[data-testid="structured-terminal-presentation"] textarea:not(:disabled)',
  paintedViewport:
    '[data-testid="structured-terminal-viewport"][data-projection-revision]',
  presentation: '[data-testid="structured-terminal-presentation"]',
  row: ".terminal-viewport-row",
  viewport: '[data-testid="structured-terminal-viewport"]',
});

const positiveInteger = (value) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
};

const alignedBounds = (host, viewport, tolerance = 1) =>
  Math.abs(host.top - viewport.top) <= tolerance &&
  Math.abs(host.left - viewport.left) <= tolerance &&
  Math.abs(host.width - viewport.width) <= tolerance &&
  Math.abs(host.height - viewport.height) <= tolerance;

export function terminalViewportGeometryFromSurface(surface) {
  const columns = positiveInteger(surface?.canonicalColumns);
  const rows = positiveInteger(surface?.viewportRows);
  return columns && rows ? { columns, rows } : null;
}

export function terminalSurfaceDiagnostics(
  host,
  selectors = TERMINAL_SURFACE_SELECTORS,
) {
  if (!host) return null;
  const presentation = host.querySelector(selectors.presentation);
  const viewport = host.querySelector(selectors.viewport);
  const rows = [...(viewport?.querySelectorAll(selectors.row) ?? [])];
  const hostBounds = host.getBoundingClientRect();
  const viewportBounds = viewport?.getBoundingClientRect();
  const style = viewport ? getComputedStyle(viewport) : undefined;
  const visibleRows = rows.filter((row) => {
    if (!row.textContent?.trim() || !viewportBounds) return false;
    const bounds = row.getBoundingClientRect();
    const rowStyle = getComputedStyle(row);
    return (
      bounds.bottom > viewportBounds.top &&
      bounds.top < viewportBounds.bottom &&
      bounds.right > viewportBounds.left &&
      bounds.left < viewportBounds.right &&
      rowStyle.display !== "none" &&
      rowStyle.visibility !== "hidden" &&
      Number(rowStyle.opacity) > 0
    );
  });
  return {
    canonicalColumns: presentation?.dataset.terminalCanonicalColumns ?? null,
    display: style?.display ?? null,
    fitSettling: host.classList.contains("terminal-fit-settling"),
    height: viewportBounds?.height ?? 0,
    hydrating: host.classList.contains("terminal-hydrating"),
    painted: viewport?.dataset.projectionRevision !== undefined,
    projectionRevision: viewport?.dataset.projectionRevision ?? null,
    renderedRowCount: rows.length,
    text: viewport?.textContent ?? "",
    viewportAligned: Boolean(
      viewportBounds && alignedBounds(hostBounds, viewportBounds),
    ),
    viewportRows: presentation?.dataset.terminalViewportRows ?? null,
    visibility: style?.visibility ?? null,
    visibleTextLength: visibleRows.reduce(
      (length, row) => length + (row.textContent?.trim().length ?? 0),
      0,
    ),
    width: viewportBounds?.width ?? 0,
  };
}

export function terminalSurfaceIsVisible(host) {
  if (!host) return false;
  const bounds = host.getBoundingClientRect();
  const style = getComputedStyle(host);
  return (
    bounds.width > 0 &&
    bounds.height > 0 &&
    bounds.right > 0 &&
    bounds.bottom > 0 &&
    bounds.left < window.innerWidth &&
    bounds.top < window.innerHeight &&
    style.display !== "none" &&
    style.visibility !== "hidden"
  );
}

export function terminalSurfaceIsPresentable(
  host,
  selectors = TERMINAL_SURFACE_SELECTORS,
  { requireVisibleText = true } = {},
) {
  return terminalSurfaceReadiness(host, selectors, {
    requireVisibleText,
  }).presentable;
}

export function terminalSurfaceReadiness(
  host,
  selectors = TERMINAL_SURFACE_SELECTORS,
  { requireVisibleText = true } = {},
) {
  const surface = terminalSurfaceDiagnostics(host, selectors);
  if (!surface) {
    return { presentable: false, reasons: ["missing"], surface: null };
  }
  const reasons = [];
  if (!surface.painted) reasons.push("unpainted");
  if (surface.hydrating) reasons.push("hydrating");
  if (surface.fitSettling) reasons.push("fit-settling");
  if (!surface.viewportAligned) reasons.push("viewport-misaligned");
  if (surface.width <= 0 || surface.height <= 0) reasons.push("zero-size");
  if (surface.display === "none" || surface.visibility === "hidden") {
    reasons.push("hidden");
  }
  if (requireVisibleText && surface.visibleTextLength <= 0) {
    reasons.push("empty-visible-text");
  }
  if (!terminalViewportGeometryFromSurface(surface)) {
    reasons.push("missing-geometry");
  }
  return { presentable: reasons.length === 0, reasons, surface };
}

export function terminalMarkerIsVisible(
  root,
  marker,
  selectors = TERMINAL_SURFACE_SELECTORS,
) {
  return [...root.querySelectorAll(selectors.host)].some((host) => {
    const surface = terminalSurfaceDiagnostics(host, selectors);
    return (
      terminalSurfaceIsPresentable(host, selectors) &&
      surface?.text.includes(marker)
    );
  });
}
