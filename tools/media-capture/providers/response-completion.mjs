import { visibleProviderText } from "./privacy.mjs";

const BUSY_PATTERNS = Object.freeze({
  codex: [/[•·]\s*Working\s*\(/iu, /esc to interrupt/iu],
  claude: [
    /\bthinking\b/iu,
    /esc to interrupt/iu,
    /^[✻✢*·]\s+\S+…/mu,
    /…\s*\([^)]*(?:thinking|thought|tokens|esc to interrupt)[^)]*\)/iu,
  ],
  kimi: [/\b(?:thinking|working)\b/iu, /esc to interrupt/iu],
});

const CHROME_LINE = /^(?:directory:|model:|OpenAI Codex|Claude Code|Kimi Code|plan mode on|auto mode unavailable|restart without|use \/skills|explain this codebase|gpt-[^\s]+|❯|›)\b/iu;
const RESPONSE_EVIDENCE = Object.freeze({
  codex: /\b(?:explored|read|ran|edited|finished|tests?|inspected|handoff|safeguard|race)\b/iu,
  claude: /\b(?:read|ran|updated|tests?|inspected|found|handoff|safeguard|race)\b/iu,
  kimi: /\b(?:read|ran|tests?|inspected|found|handoff|safeguard|race)\b/iu,
});

function normalizeLine(line) {
  return line.replace(/\s+/gu, " ").trim();
}

export function providerResponseBusy(provider, screen) {
  return (BUSY_PATTERNS[provider] ?? []).some((pattern) =>
    pattern.test(screen),
  );
}

function providerInputReady(provider, screen) {
  if (providerResponseBusy(provider, screen)) return false;
  switch (provider) {
    case "codex":
      return screen.includes("›");
    case "claude":
      return screen.includes("❯") && screen.toLowerCase().includes("plan mode on");
    case "kimi":
      return /(?:Kimi\s*>|^>\s*$)/imu.test(screen);
    default:
      return false;
  }
}

export function substantiveProviderResponseLines(
  provider,
  screen,
  { baseline, prompt },
) {
  const baselineLines = new Set(
    visibleProviderText(baseline).split("\n").map(normalizeLine).filter(Boolean),
  );
  const normalizedPrompt = normalizeLine(prompt).toLowerCase();
  const lines = visibleProviderText(screen)
    .split("\n")
    .map(normalizeLine);
  const promptEnd = lines.reduce((lastIndex, line, index) => {
    const comparable = line
      .replace(/^[>›❯•⏺✻✢*·\s]+/u, "")
      .toLowerCase();
    return comparable.length >= 8 && normalizedPrompt.includes(comparable)
      ? index
      : lastIndex;
  }, -1);
  return lines
    .map((line, index) => ({ index, line }))
    .filter(({ index, line }) => {
      if (
        (promptEnd >= 0 && index <= promptEnd) ||
        line.length < 12 ||
        baselineLines.has(line) ||
        CHROME_LINE.test(line) ||
        providerResponseBusy(provider, line) ||
        /^[❯›]\s/u.test(line)
      ) {
        return false;
      }
      const comparable = line
        .replace(/^[>›❯•⏺✻✢*·\s]+/u, "")
        .toLowerCase();
      return comparable.length >= 12 && !normalizedPrompt.includes(comparable);
    })
    .map(({ line }) => line);
}

export function providerResponseComplete(
  provider,
  screen,
  { baseline, prompt },
) {
  const response = substantiveProviderResponseLines(provider, screen, {
    baseline,
    prompt,
  }).join(" ");
  const hasEvidence = RESPONSE_EVIDENCE[provider]?.test(response) === true;
  return (
    hasEvidence &&
    (response.length >= 120 ||
      (response.length >= 40 && providerInputReady(provider, screen)))
  );
}
