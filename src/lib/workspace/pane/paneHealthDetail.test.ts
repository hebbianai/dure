import { beforeEach, describe, expect, it } from "vitest";
import { setLang } from "@/lib/i18n";
import type { HmuxSessionSummary } from "@/lib/ipc";
import {
	hmuxPaneSessionLabel,
	paneHealthChipTitle,
} from "@/lib/workspace/pane/paneHealthDetail";

const metadata: HmuxSessionSummary = {
	sessionId: "standalone_abc",
	sessionName: "web-dev",
	workspaceId: "ws-1",
	sessionClass: "standalone",
	lifecycle: "ready",
	hostBuildVersion: "0.1.1+abcdef123456",
	terminalEpoch: "1",
	outputSeq: "0",
	capabilities: [],
};

describe("hmuxPaneSessionLabel", () => {
	it("names the session, falls back to its id, then to the runtime", () => {
		expect(hmuxPaneSessionLabel("web-dev", "s1")).toBe("web-dev");
		expect(hmuxPaneSessionLabel("", "s1")).toBe("Hmux s1");
		expect(hmuxPaneSessionLabel(undefined, "s1")).toBe("Hmux s1");
		expect(hmuxPaneSessionLabel(undefined, undefined)).toBe("Hmux");
	});
});

describe("paneHealthChipTitle", () => {
	beforeEach(() => setLang("en"));

	it("lists identity, host build, policy and every health receipt it has", () => {
		const title = paneHealthChipTitle({
			sessionLabel: "web-dev",
			metadata: {
				...metadata,
				retirementPolicy: {
					kind: "after_graceful_last_client_departure_v1",
					gracePeriodMs: 5_000,
				},
			},
			healthState: "error",
			health: {
				reason: "transport_closed",
				terminalEpoch: "1",
				receivedSequence: 5,
			},
		});
		expect(title.split(" · ")).toEqual([
			"web-dev",
			"standalone",
			"host 0.1.1+abcdef123456",
			"Auto-clean up after closing the last pane",
			"Hmux error",
			"transport_closed",
			"epoch 1",
			"received 5",
		]);
	});

	it("says only the state when there is nothing else to report", () => {
		expect(
			paneHealthChipTitle({
				sessionLabel: "Hmux",
				metadata: undefined,
				healthState: "stale",
				health: undefined,
			}),
		).toBe("Hmux · Hmux stale");
	});
});
