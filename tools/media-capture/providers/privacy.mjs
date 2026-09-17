const EMAIL_ADDRESS_SOURCE = String.raw`\b(?:[A-Z0-9._%+-](?:\r?\n)?)+@(?:[A-Z0-9-](?:\r?\n)?)+(?:\.(?:\r?\n)?(?:[A-Z0-9-](?:\r?\n)?)+)+\b`;
const INVISIBLE_PROVIDER_CONTROL_SOURCE = String.raw`(?:\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[@-_]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f])`;

export function visibleTextWithRawOffsets(screen) {
  const invisible = new RegExp(INVISIBLE_PROVIDER_CONTROL_SOURCE, "gu");
  const rawOffsets = [];
  let visible = "";
  let cursor = 0;
  const appendVisible = (chunk, rawStart) => {
    visible += chunk;
    for (let index = 0; index < chunk.length; index += 1) {
      rawOffsets.push(rawStart + index);
    }
  };
  for (const match of screen.matchAll(invisible)) {
    appendVisible(screen.slice(cursor, match.index), cursor);
    cursor = match.index + match[0].length;
  }
  appendVisible(screen.slice(cursor), cursor);
  return { visible, rawOffsets };
}

function replaceVisibleMatches(screen, pattern, replacement) {
  const { visible, rawOffsets } = visibleTextWithRawOffsets(screen);
  const matches = [...visible.matchAll(pattern)];
  let normalized = screen;
  for (const match of matches.reverse()) {
    const start = rawOffsets[match.index];
    const end = rawOffsets[match.index + match[0].length - 1] + 1;
    normalized = `${normalized.slice(0, start)}${replacement}${normalized.slice(end)}`;
  }
  return normalized;
}

const SECRET_PATTERNS = Object.freeze([
  ["provider account tier", /\bClaude\s+(?:Max|Pro|Team|Enterprise)\b/iu],
  ["provider account display name", /Welcome back\s+[^!\u001b]{1,64}!/iu],
  [
    "email address",
    new RegExp(EMAIL_ADDRESS_SOURCE, "iu"),
  ],
  ["private key", /-----BEGIN (?:OPENSSH|RSA|EC|DSA|PGP) PRIVATE KEY-----/iu],
  ["OpenAI-style key", /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{12,}/u],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/u],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/u],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{24,}\b/u],
  ["bearer credential", /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}={0,2}\b/iu],
  [
    "named credential",
    /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|client[_ -]?secret)\b\s*[:=]\s*["']?[^\s"']{8,}/iu,
  ],
  [
    "environment credential",
    /\b[A-Z][A-Z0-9_]*(?:API_KEY|ACCESS_KEY|AUTH_TOKEN|OAUTH_TOKEN|PASSWORD|SECRET|TOKEN)\s*=\s*["']?[^\s"']{8,}/u,
  ],
  [
    "credential URL",
    /https?:\/\/\S+[?&](?:access_token|code|key|secret|token)=[^\s&]{6,}/iu,
  ],
]);

const UNSAFE_OUTPUT_PATTERNS = Object.freeze([
  ...SECRET_PATTERNS,
  ["private home path", /\/(?:Users|home)\/[^\s]+/u],
  [
    "ambient lifecycle hook failure",
    /\b(?:SessionStart|SessionEnd|PreToolUse|PostToolUse|UserPromptSubmit|Stop)\s+hook\s+\(failed\)|\bhook exited with code\b/iu,
  ],
]);

const AUTH_REQUIRED_PATTERNS = Object.freeze([
  /\b(?:authentication|authorization) (?:is )?required\b/iu,
  /\b(?:please |you must )?(?:log in|login|sign in)\b/iu,
  /\bdevice[- ]code\b/iu,
  /\b(?:oauth|authorize this device)\b/iu,
  /https?:\/\/\S+\/(?:device|login|oauth|authorize)(?:\b|[/?#])/iu,
]);

const TRANSIENT_PROVIDER_DIAGNOSTIC_PATTERNS = Object.freeze([
  /^[ \t]*⚠(?:️)?[ \t]+MCP startup interrupted\.[^\r\n]*(?:\r?\n[ \t]*(?:initialized:|servers:)[^\r\n]*)?\r?\n?/gimu,
  /^[ \t]*⚠(?:️)?[ \t]+Safe mode:[\s\S]*?^[ \t]*Restart without --safe-mode to re-enable[^\r\n]*\r?\n?/gimu,
  /^[ \t]*auto mode unavailable for this model[^\r\n]*\r?\n?/gimu,
  /^[ \t]*Update available! Run: brew upgrade claude-code@[^\r\n]*\r?\n?/gimu,
]);

export class UnsafeProviderOutputError extends Error {
  constructor(provider, category) {
    super(`live ${provider} screen contains forbidden ${category}`);
    this.name = "UnsafeProviderOutputError";
    this.provider = provider;
    this.category = category;
  }
}

export class ProviderAuthenticationRequiredError extends Error {
  constructor(provider) {
    super(`live ${provider} CLI requires authentication`);
    this.name = "ProviderAuthenticationRequiredError";
    this.provider = provider;
  }
}

export function normalizeProviderScreen(
  screen,
  {
    home,
    ownedPaths = [],
    abbreviatedPathAlias = "~/dure-demo",
  } = {},
) {
  let normalized = screen;
  const replacements = ownedPaths
    .filter(
      ({ path, alias }) =>
        typeof path === "string" &&
        path.length > 0 &&
        typeof alias === "string" &&
        alias.length > 0,
    )
    .sort((left, right) => right.path.length - left.path.length);
  for (const { path, alias } of replacements) {
    normalized = normalized.split(path).join(alias);
  }
  // Canonical ANSI repaints arrive after the provider TUI has wrapped long
  // paths to terminal rows. In that case the leading row can be replaced by
  // the home-path rule below while a component-boundary suffix such as
  // `HebbianIDE/.worktrees/media-capture/output` survives on the next row.
  // Replace longest owned-path suffixes first so the public alias does not
  // retain a private parent prefix.
  const wrappedSuffixes = replacements
    .flatMap(({ path, alias }) => {
      const components = path.split("/").filter(Boolean);
      const suffixes = components.slice(1).map((_, index) => ({
        path: components.slice(index + 1).join("/"),
        alias,
      }));
      const basename = components.at(-1) ?? "";
      for (let index = 1; index <= basename.length - 12; index += 1) {
        suffixes.push({ path: basename.slice(index), alias });
      }
      return suffixes;
    })
    .filter(({ path }) => path.length >= 12)
    .sort((left, right) => right.path.length - left.path.length);
  for (const { path, alias } of wrappedSuffixes) {
    normalized = normalized.split(path).join(alias);
  }
  if (home) normalized = normalized.split(home).join("~");
  // A disposable HOME can differ from the checkout's real home. The provider
  // may abbreviate that absolute cwd before capture, defeating exact aliases.
  normalized = replaceVisibleMatches(
    normalized,
    /\/(?:Users|home)\/[^\s]+/gu,
    abbreviatedPathAlias,
  );
  // Provider TUIs can abbreviate their cwd before Hmux observes it, so exact
  // replacement alone is insufficient. Keep the stable public alias and
  // collapse every other home-relative path without touching ANSI controls.
  normalized = normalized.replace(
    /~\/(?!dure-demo(?:\/|\s|$))[^\s\u001b]+/gu,
    abbreviatedPathAlias,
  );
  normalized = replaceVisibleMatches(
    normalized,
    /Welcome back\s+[^!]{1,64}!/giu,
    "Welcome to Dure demo!",
  );
  normalized = replaceVisibleMatches(
    normalized,
    new RegExp(EMAIL_ADDRESS_SOURCE, "giu"),
    "Dure demo account",
  );
  normalized = replaceVisibleMatches(
    normalized,
    /Claude\s+(?:Max|Pro|Team|Enterprise)\b/giu,
    "Claude Code",
  );
  for (const pattern of TRANSIENT_PROVIDER_DIAGNOSTIC_PATTERNS) {
    normalized = replaceVisibleMatches(normalized, pattern, "");
  }
  return normalized;
}

export function visibleProviderText(screen) {
  return screen.replace(
    new RegExp(INVISIBLE_PROVIDER_CONTROL_SOURCE, "gu"),
    "",
  );
}

export function assertProviderScreenSafe(provider, screen) {
  const visible = visibleProviderText(screen);
  for (const [category, pattern] of UNSAFE_OUTPUT_PATTERNS) {
    if (pattern.test(visible)) {
      throw new UnsafeProviderOutputError(provider, category);
    }
  }
  if (AUTH_REQUIRED_PATTERNS.some((pattern) => pattern.test(visible))) {
    throw new ProviderAuthenticationRequiredError(provider);
  }
  return screen;
}

export function providerPrivacyViolations(screen) {
  const visible = visibleProviderText(screen);
  return UNSAFE_OUTPUT_PATTERNS.filter(([, pattern]) =>
    pattern.test(visible),
  ).map(([category]) => category);
}
