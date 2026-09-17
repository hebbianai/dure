import { describe, expect, it } from "vitest";
import type { ProviderWiringStatus } from "@/lib/ipc";
import {
	codexSupportsNativeLifecycle,
	completionSource,
	providerWiringRows,
} from "./providerWiring";

const wiring = (
	claudePublished: boolean,
	notifyPublished: boolean,
	overlay: { notifyMerged: boolean; trustRekeyed: boolean } | null,
): ProviderWiringStatus => ({
	claude: { managedHooksPublished: claudePublished },
	codex: { notifyPublished, overlay },
});

describe("completionSource", () => {
	it("claude는 managed 훅 발행이 유효할 때만 훅 이벤트 원천이다", () => {
		expect(completionSource("claude", wiring(true, false, null))).toBe("hook_events");
		expect(completionSource("claude", wiring(false, false, null))).toBe("inference");
	});

	it("classifies native Codex lifecycle hooks as exact regardless of account overlay", () => {
		const merged = { notifyMerged: true, trustRekeyed: true };
		expect(completionSource("codex", wiring(false, true, merged), "codex-cli 0.151.0")).toBe(
			"hook_events",
		);
		expect(completionSource("codex", wiring(false, true, null), "0.152.1")).toBe(
			"hook_events",
		);
		expect(
			completionSource(
				"codex",
				wiring(false, true, { notifyMerged: false, trustRekeyed: true }),
				"codex-cli 1.0.0",
			),
		).toBe("hook_events");
		expect(completionSource("codex", wiring(false, false, merged), "0.151.0")).toBe(
			"inference",
		);
	});

	it("labels legacy or unknown Codex versions as approximate turn reports", () => {
		expect(completionSource("codex", wiring(false, true, null), "codex-cli 0.150.9")).toBe(
			"turn_notify",
		);
		expect(completionSource("codex", wiring(false, true, null))).toBe("turn_notify");
		expect(codexSupportsNativeLifecycle("not-semver")).toBe(false);
	});

	it("나머지 provider와 상태 미조회는 화면 추론이다", () => {
		expect(completionSource("kimi", wiring(true, true, null))).toBe("inference");
		expect(completionSource("claude", null)).toBe("inference");
	});
});

describe("providerWiringRows", () => {
	it("오버레이 없는 계정(시스템 기본값)은 합성 행이 해당 없음(null)이다", () => {
		expect(providerWiringRows("codex", wiring(false, true, null))).toEqual([
			{ key: "notifyPublished", value: true },
			{ key: "notifyMerged", value: null },
			{ key: "trustRekeyed", value: null },
		]);
	});

	it("오버레이가 있으면 합성·재키잉 상태를 그대로 싣는다", () => {
		expect(
			providerWiringRows("codex", wiring(false, true, { notifyMerged: true, trustRekeyed: false })),
		).toEqual([
			{ key: "notifyPublished", value: true },
			{ key: "notifyMerged", value: true },
			{ key: "trustRekeyed", value: false },
		]);
	});
});
