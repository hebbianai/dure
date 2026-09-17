import { describe, expect, it, vi } from "vitest";
import {
	type CliHmuxPaneActivationDependencies,
	projectStandalonePaneReceipt,
	resolveCliHmuxPlacement,
	resolveCliStandaloneHmuxSession,
	waitForCliHmuxPaneActivation,
} from "@/lib/cli/cliHmuxPaneActivation";
import type { HmuxPaneAttachmentStatus, HmuxSessionSummary } from "@/lib/ipc";

const attachment: HmuxPaneAttachmentStatus = {
	ownerId: "pane-owner",
	sessionId: "standalone-a",
	workspaceId: "workspace-a",
	state: "attached",
	observerAttached: true,
	controllerAttached: false,
};

const session = {
	sessionId: "standalone-a",
	workspaceId: "workspace-a",
	sessionClass: "standalone",
	lifecycle: "ready",
} as HmuxSessionSummary;

describe("CLI Hmux pane activation", () => {
	it("delegates the live window labels to the exact status lookup", async () => {
		const waitForAnyExact: CliHmuxPaneActivationDependencies["waitForAnyExact"] =
			vi.fn(async (identity, _windowLabels, status) =>
				status({
					ownerId: "pane-owner",
					sessionId: identity.sessionId,
					workspaceId: identity.workspaceId,
				}),
			);
		const attachmentStatus = vi.fn(async () => attachment);

		await expect(
			waitForCliHmuxPaneActivation(
				{
					desktopId: "desktop-a",
					panelId: "term:a",
					sessionId: "standalone-a",
					workspaceId: "workspace-a",
				},
				{
					windowLabels: async () => ["main"] as const,
					waitForAnyExact,
					attachmentStatus,
				},
			),
		).resolves.toEqual(attachment);
		expect(waitForAnyExact).toHaveBeenCalledWith(
			{
				desktopId: "desktop-a",
				panelId: "term:a",
				sessionId: "standalone-a",
				workspaceId: "workspace-a",
			},
			["main"],
			attachmentStatus,
		);
	});

	it("accepts an exact secondary-window attachment when main coordinated the pane commit", async () => {
		const secondaryAttachment: HmuxPaneAttachmentStatus = {
			...attachment,
			ownerId: "window:win-1788099326856-0:desktop:desktop-a:pane:term:a",
		};
		const waitForAnyExact = vi.fn(async () => secondaryAttachment);
		const dependencies = {
			windowLabels: async () =>
				["main", "win-1788099326856-0"] as [string, ...string[]],
			waitForAnyExact,
			attachmentStatus: vi.fn(async () => secondaryAttachment),
		};

		await expect(
			waitForCliHmuxPaneActivation(
				{
					desktopId: "desktop-a",
					panelId: "term:a",
					sessionId: "standalone-a",
					workspaceId: "workspace-a",
				},
				dependencies,
			),
		).resolves.toEqual(secondaryAttachment);
		expect(waitForAnyExact).toHaveBeenCalledWith(
			{
				desktopId: "desktop-a",
				panelId: "term:a",
				sessionId: "standalone-a",
				workspaceId: "workspace-a",
			},
			["main", "win-1788099326856-0"],
			dependencies.attachmentStatus,
		);
	});

	it("builds the canonical standalone pane projection", () => {
		expect(
			projectStandalonePaneReceipt(
				{
					desktopId: "desktop-a",
					panelId: "term:a",
					sessionId: "standalone-a",
					workspaceId: "workspace-a",
					sessionOwnership: "created_by_request",
				},
				attachment,
			),
		).toMatchObject({
			runtime: "hmux_standalone_v1",
			source: "local",
			hostId: "local",
			mode: "controller",
			binding: {
				runtime: "hmux_standalone_v1",
				source: "local",
				sessionId: "standalone-a",
				workspaceId: "workspace-a",
			},
			attachment,
		});
	});

	it("returns a durable retarget projection without inventing a native attachment", () => {
		const pane = projectStandalonePaneReceipt({
			desktopId: "desktop-a",
			panelId: "term:a",
			sessionId: "standalone-a",
			workspaceId: "workspace-a",
		});

		expect(pane).not.toHaveProperty("attachment");
		expect(pane.binding).toEqual({
			schemaVersion: 1,
			runtime: "hmux_standalone_v1",
			source: "local",
			hostId: "local",
			sessionId: "standalone-a",
			workspaceId: "workspace-a",
		});
	});

	it("resolves and validates an exact standalone attach target", async () => {
		const inspectSession = vi.fn(async () => session);

		await expect(
			resolveCliStandaloneHmuxSession(
				{
					sessionId: "standalone-a",
					workspaceId: "workspace-a",
				},
				{
					resolveNamedSession: vi.fn(),
					inspectSession,
				},
			),
		).resolves.toBe(session);
		expect(inspectSession).toHaveBeenCalledWith({
			sessionId: "standalone-a",
			workspaceId: "workspace-a",
		});
	});

	it("refuses a managed session before pane activation", async () => {
		await expect(
			resolveCliStandaloneHmuxSession(
				{ name: "managed-a" },
				{
					resolveNamedSession: vi.fn(async () => ({
						...session,
						sessionId: "managed-a",
						sessionClass: "managed" as const,
					})),
					inspectSession: vi.fn(),
				},
			),
		).rejects.toMatchObject({
			code: "invalid_request",
			message:
				"Hmux session managed-a is managed and cannot use standalone attach",
		});
	});

	it("parses placement and preserves the resolved pane reference", async () => {
		const resolveReference = vi.fn(async () => ({
			desktopId: "desktop-a",
			panelId: "term:reference",
			cwd: "/project",
		}));

		await expect(
			resolveCliHmuxPlacement(
				{
					placement: {
						referenceSessionId: "standalone-reference",
						referencePanelId: "term:reference",
						direction: "right",
					},
				},
				resolveReference,
			),
		).resolves.toEqual({
			desktopId: "desktop-a",
			panelId: "term:reference",
			cwd: "/project",
			direction: "right",
			position: {
				referencePanel: "term:reference",
				direction: "right",
			},
		});
		expect(resolveReference).toHaveBeenCalledWith(
			"standalone-reference",
			"term:reference",
		);
	});
});
