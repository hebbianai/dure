const CODEX_TRUST_PROMPTS = Object.freeze([
  "Do you trust the contents of this directory?",
  "Do you trust this directory?",
]);
const CLAUDE_EXTERNAL_IMPORT_PROMPTS = Object.freeze([
  "Allow external CLAUDE.md file imports?",
  "allow external imports",
]);
const CLAUDE_TRUST_PROMPTS = Object.freeze([
  "Do you trust the files in this folder?",
  "Do you trust this project?",
]);

function lastIndexOfAny(screen, prompts) {
  return Math.max(...prompts.map((prompt) => screen.lastIndexOf(prompt)));
}

function codexReadySurfaceFollows(screen, promptIndex) {
  return (
    screen.lastIndexOf("›") > promptIndex &&
    screen.lastIndexOf(" · ") > promptIndex
  );
}

function claudeReadySurfaceFollows(screen, promptIndex) {
  return screen.toLowerCase().lastIndexOf("plan mode on") > promptIndex;
}

function menuChoiceKeys(screen, target) {
  const selected = screen.indexOf("❯");
  const selectedLine = screen.slice(selected, screen.indexOf("\n", selected));
  const destination = target.exec(screen)?.index ?? -1;
  if (
    selected < 0 ||
    destination < 0 ||
    Math.abs(destination - selected) > 256 ||
    !screen.includes("Enter to confirm")
  ) {
    return null;
  }
  if (target.test(selectedLine)) return ["Enter"];
  return [destination < selected ? "Up" : "Down", "Enter"];
}

export function providerStartupKeys(provider, screen) {
  const codexTrustIndex = lastIndexOfAny(screen, CODEX_TRUST_PROMPTS);
  if (
    provider === "codex" &&
    codexTrustIndex >= 0 &&
    !codexReadySurfaceFollows(screen, codexTrustIndex)
  ) {
    // Codex is already fenced by --sandbox read-only and approval=never. This
    // accepts only the disposable fixture repo, never a provider permission.
    return ["Enter"];
  }
  const claudeImportIndex = lastIndexOfAny(
    screen,
    CLAUDE_EXTERNAL_IMPORT_PROMPTS,
  );
  if (
    provider === "claude" &&
    claudeImportIndex >= 0 &&
    !claudeReadySurfaceFollows(screen, claudeImportIndex)
  ) {
    // The safe choice is the second row: keep the session but decline imports
    // that point outside the disposable fixture.
    return ["Down", "Enter"];
  }
  if (provider === "claude") {
    const trustChoice = menuChoiceKeys(screen, /\bYes,\s+I\s+trust\b/iu);
    if (trustChoice) return trustChoice;
  }
  const claudeTrustIndex = lastIndexOfAny(screen, CLAUDE_TRUST_PROMPTS);
  if (
    provider === "claude" &&
    claudeTrustIndex >= 0 &&
    !claudeReadySurfaceFollows(screen, claudeTrustIndex)
  ) {
    // Safe mode plus plan permission limits this session to inspection.
    return ["Enter"];
  }
  return null;
}

export function providerScreenReady(provider, screen) {
  if (providerStartupKeys(provider, screen)) return false;
  switch (provider) {
    case "codex":
      return screen.includes("OpenAI Codex") && screen.includes("model:");
    case "claude":
      return screen.includes("❯") || screen.includes("Claude Code");
    case "kimi":
      return screen.includes("Kimi Code") || screen.includes("Kimi");
    default:
      return false;
  }
}
