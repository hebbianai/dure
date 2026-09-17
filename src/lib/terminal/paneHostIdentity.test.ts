import { describe, expect, it } from "vitest";
import {
	classifyTerminalPaneHost,
	terminalPaneHostId,
	terminalPaneReferencedHostIds,
} from "@/lib/terminal/paneHostIdentity";
import {
	hmuxLocalBinding,
	remoteHmuxStandaloneBinding,
} from "@/lib/terminal/terminalBinding";

describe("terminalPaneHostId", () => {
	it("uses the canonical binding before legacy pane parameters", () => {
		expect(
			terminalPaneHostId({
				hostId: "legacy-host",
				binding: remoteHmuxStandaloneBinding(
					"session-1",
					"workspace-1",
					"canonical-host",
					"bridge-1",
				),
			}),
		).toBe("canonical-host");
	});

	it("retains the top-level Host id for pre-binding SSH panes", () => {
		expect(terminalPaneHostId({ hostId: "legacy-host" })).toBe("legacy-host");
		expect(terminalPaneHostId({ hostId: "local" })).toBeUndefined();
	});

	it("does not let legacy parameters override a canonical local binding", () => {
		expect(
			terminalPaneHostId({
				hostId: "stale-remote-host",
				binding: hmuxLocalBinding("session-1", "workspace-1"),
			}),
		).toBeUndefined();
	});

	it.each([
		{ schemaVersion: 1, runtime: "hmux_managed_v1" },
		{ schemaVersion: 2, source: "ssh", hostId: "future-host" },
	])(
		"does not reinterpret an explicit invalid binding as legacy Host ownership",
		(binding) => {
			expect(
				terminalPaneHostId({ hostId: "legacy-host", binding }),
			).toBeUndefined();
		},
	);

	it("does not down-convert a complete forward-version binding", () => {
		const params = {
			hostId: "future-host",
			binding: {
				...remoteHmuxStandaloneBinding(
					"session-future",
					"workspace-future",
					"future-host",
					"bridge-future",
				),
				schemaVersion: 2,
			},
		};
		expect(terminalPaneHostId(params)).toBeUndefined();
		expect(classifyTerminalPaneHost(params, "future-host")).toBe(
			"unresolved",
		);
		expect(terminalPaneReferencedHostIds(params)).toEqual(["future-host"]);
	});

	it("lets a valid local binding override stale raw Host evidence", () => {
		expect(
			classifyTerminalPaneHost(
				{
					hostId: "stale-remote-host",
					binding: hmuxLocalBinding("session-1", "workspace-1"),
				},
				"stale-remote-host",
			),
		).toBe("other");
	});

	it("uses valid canonical and legacy Host ownership for destructive selection", () => {
		expect(
			classifyTerminalPaneHost(
				{
					binding: remoteHmuxStandaloneBinding(
						"session-1",
						"workspace-1",
						"canonical-host",
						"bridge-1",
					),
				},
				"canonical-host",
			),
		).toBe("owned");
		expect(
			classifyTerminalPaneHost({ hostId: "legacy-host" }, "legacy-host"),
		).toBe("owned");
	});
});
