const AMBIENT_HMUX_ENVIRONMENT = Object.freeze([
  "HMUX",
  "HMUX_SESSION_ID",
  "HMUX_SESSION_NAME",
  "HMUX_WORKSPACE_ID",
]);

export function terminalCaptureSize(
  scenario,
  provider,
  sessionId,
  measuredSizes,
) {
  const size =
    measuredSizes?.[sessionId] ??
    scenario.liveSessionTerminalSizes?.[sessionId] ??
    scenario.liveProviderTerminalSizes?.[provider] ??
    scenario.liveTerminalSize ??
    { columns: 52, rows: 15 };
  if (
    !Number.isInteger(size.columns) ||
    size.columns < 40 ||
    !Number.isInteger(size.rows) ||
    size.rows < 12
  ) {
    throw new Error("liveTerminalSize must be at least 40 columns by 12 rows");
  }
  return size;
}

export function terminalGeometryFitsViewport(
  source,
  viewport,
  { closeFit = false } = {},
) {
  if (
    !Number.isInteger(source?.columns) ||
    !Number.isInteger(source?.rows) ||
    !Number.isInteger(viewport?.columns) ||
    !Number.isInteger(viewport?.rows) ||
    source.columns > viewport.columns ||
    source.rows > viewport.rows
  ) {
    return false;
  }
  return (
    !closeFit ||
    (viewport.columns - source.columns <= 2 &&
      viewport.rows - source.rows <= 1)
  );
}

export async function resizeHmuxSession(state, sessionId) {
  const env = { ...state.env };
  for (const key of AMBIENT_HMUX_ENVIRONMENT) delete env[key];
  const result = await state.run(
    state.hmux,
    [
      "--discovery-root",
      state.fixture.discoveryRoot,
      "--json",
      "resize",
      "--target",
      sessionId,
      "--columns",
      String(state.terminalSize.columns),
      "--rows",
      String(state.terminalSize.rows),
    ],
    { env, timeoutMs: 5_000 },
  );
  let receipt;
  try {
    receipt = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error("hmux resize returned invalid JSON", { cause: error });
  }
  if (
    receipt?.schemaVersion !== 1 ||
    receipt.ok !== true ||
    receipt.sessionId !== sessionId ||
    receipt.receipt?.state !== "applied_to_terminal" ||
    receipt.receipt.columns !== state.terminalSize.columns ||
    receipt.receipt.rows !== state.terminalSize.rows
  ) {
    throw new Error("hmux resize did not confirm the exact capture geometry");
  }
  return {
    columns: receipt.receipt.columns,
    rows: receipt.receipt.rows,
  };
}
