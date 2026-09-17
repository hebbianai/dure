import { describe, expect, it } from "vitest";
import {
	clearManagedShellMigrationLayout,
	managedShellMigrationPayloadFromPanel,
	managedShellMigrationTargetBinding,
	projectManagedShellMigrationLayout,
	type ManagedShellMigrationPayloadV1,
} from "@/lib/sessions/managed/managedShellMigration";
import { hmuxStandaloneBinding } from "@/lib/terminal/terminalBinding";
import { stopFenceFixture } from "@/test/agentFixtures";

const source = hmuxStandaloneBinding("source-session", "workspace-1");
const stopFence = stopFenceFixture({
	hostInstanceId: "host-1",
	terminalEpoch: "target-epoch",
});
const target = managedShellMigrationTargetBinding({
	sessionId: "target-session",
	workspaceId: "workspace-1",
	idempotencyKey: "promote_shell_123",
	stopFence,
});

function payload(): ManagedShellMigrationPayloadV1 {
	return {
		schemaVersion: 1,
		operationId: "promote_shell_123",
		source,
		sourceTerminalEpoch: "source-epoch",
		target,
		targetTerminalEpoch: "target-epoch",
		desktopId: "desktop-1",
		panelId: "term:source-session",
		cwd: "/repo",
	};
}

function sourceLayout() {
	return {
		panels: {
			"term:source-session": {
				params: {
					sessionId: source.sessionId,
					cwd: "/old",
					binding: source,
				},
			},
		},
	};
}

describe("managed shell migration layout", () => {
	it("projects an exact standalone source to the managed target and journals it", () => {
		const result = projectManagedShellMigrationLayout(
			sourceLayout(),
			payload(),
		);
		expect(result.state).toBe("source");
		const panel = (result.layout as ReturnType<typeof sourceLayout>).panels[
			"term:source-session"
		];
		expect(panel.params).toMatchObject({
			sessionId: "target-session",
			cwd: "/repo",
			binding: target,
			managedShellMigration: {
				operationId: "promote_shell_123",
				source,
				sourceTerminalEpoch: "source-epoch",
				target,
				targetTerminalEpoch: "target-epoch",
			},
		});
		expect(
			managedShellMigrationPayloadFromPanel(
				"desktop-1",
				"term:source-session",
				panel.params,
			),
		).toEqual(payload());
	});

	it("is idempotent for the exact journaled target", () => {
		const first = projectManagedShellMigrationLayout(sourceLayout(), payload());
		const second = projectManagedShellMigrationLayout(first.layout, payload());
		expect(second.state).toBe("target");
		expect(second.layout).toEqual(first.layout);
	});

	it("fails closed when the source binding changed", () => {
		const layout = sourceLayout();
		layout.panels["term:source-session"].params.binding = hmuxStandaloneBinding(
			"replacement",
			"workspace-1",
		);
		expect(projectManagedShellMigrationLayout(layout, payload()).state).toBe(
			"conflict",
		);
	});

	it("clears only the exact target journal", () => {
		const projected = projectManagedShellMigrationLayout(
			sourceLayout(),
			payload(),
		);
		const cleared = clearManagedShellMigrationLayout(
			projected.layout,
			payload(),
		);
		expect(cleared.cleared).toBe(true);
		const panel = (cleared.layout as ReturnType<typeof sourceLayout>).panels[
			"term:source-session"
		];
		expect(panel.params.binding).toEqual(target);
		expect("managedShellMigration" in panel.params).toBe(false);

		const wrong = { ...payload(), operationId: "different-operation" };
		expect(
			clearManagedShellMigrationLayout(projected.layout, wrong).cleared,
		).toBe(false);
	});

	it("ignores malformed persisted markers", () => {
		const projected = projectManagedShellMigrationLayout(
			sourceLayout(),
			payload(),
		);
		const panel = (
			projected.layout as {
				panels: Record<string, { params: Record<string, unknown> }>;
			}
		).panels["term:source-session"];
		panel.params.managedShellMigration = {
			schemaVersion: 1,
			operationId: "",
		};
		expect(
			managedShellMigrationPayloadFromPanel(
				"desktop-1",
				"term:source-session",
				panel.params,
			),
		).toBeUndefined();
	});
});
