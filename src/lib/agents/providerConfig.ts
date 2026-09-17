import { runShell } from "@/lib/ipc/process";
import { activeAccount } from "@/lib/agents/providers";
import type { Provider } from "@/types";
import { shellQuote as sq } from "@/lib/platform/shell";

const CANONICAL_CONFIG_DIRECTORY_SUFFIXES: Partial<Record<Provider, string>> = {
  claude: "/.claude",
};

/** 프로바이더 설정 디렉터리(활성 계정 우선, 없으면 기본) — 절대경로. */
export async function configDir(provider: Provider, home: string): Promise<string> {
  // Overlay provider 설정 편집은 canonical home만 변경한다. Thin credential profile은
  // 다음 spawn preflight에서 이 config를 원자 sync하고 shared state를 참조한다.
  if (provider === "codex") return `${home}/.codex`;
  if (provider === "claude") return `${home}/.claude`;
  const acc = activeAccount(provider);
  if (acc?.dir) return acc.dir;
  return `${home}/.kimi-code`;
}

/** 해당 프로바이더 설정 디렉터리를 가리키는 env 프리픽스 (CLI 실행용). */
export function envPrefix(provider: Provider, dir: string): string {
  if (provider === "codex") return "";
  // Claude's canonical default is split between ~/.claude/* and
  // ~/.claude.json. Setting CLAUDE_CONFIG_DIR=~/.claude would instead move the
  // latter to ~/.claude/.claude.json, so canonical config commands must inherit
  // the provider default. Thin account roots never end in "/.claude".
  const canonicalSuffix = CANONICAL_CONFIG_DIRECTORY_SUFFIXES[provider];
  if (canonicalSuffix && dir.endsWith(canonicalSuffix)) return "";
  const v = provider === "claude" ? "CLAUDE_CONFIG_DIR" : "KIMI_CODE_HOME";
  return `${v}=${sq(dir)} `;
}

/** 텍스트 설정 파일 읽기 (cat — CLAUDE_CONFIG_DIR/~ 확장) */
export async function readTextFile(path: string): Promise<string> {
  const r = await runShell(`cat ${sq(path)} 2>/dev/null`);
  return r.stdout;
}

/** 바이트 크기만 조회(wc -c) — 전체를 읽지 않고 상한을 검사하고 싶을 때
 *  readTextFile 앞에 쓴다. 못 읽으면(권한·미존재) 0. */
export async function fileSizeBytes(path: string): Promise<number> {
  const r = await runShell(`wc -c < ${sq(path)} 2>/dev/null`);
  const n = Number.parseInt(r.stdout.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}
