import type { Provider } from "@/types";

export type TerminalProviderFixture = Extract<Provider, "claude" | "codex">;

const TERMINAL_PROVIDER_FIXTURES = new Set<TerminalProviderFixture>([
	"claude",
	"codex",
]);

export function requireTerminalProviderFixture(
	candidate: string | undefined,
): TerminalProviderFixture {
	if (TERMINAL_PROVIDER_FIXTURES.has(candidate as TerminalProviderFixture)) {
		return candidate as TerminalProviderFixture;
	}
	throw new Error("large-view QA requires a configured provider fixture");
}
