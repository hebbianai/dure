// @vitest-environment jsdom

import { chooseSelectValue, openSelect } from "@/test/select";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { BrowserPaneSession } from "@/lib/browser/browserPaneSession";
import { createDureBrowserClient } from "@/lib/ipc/dureBrowser";
import { BrowserProfileDialog } from "./BrowserProfileDialog";

vi.mock("@/lib/i18n", () => ({ t: (key: string) => key }));

async function fixture(
	owned = true,
	fault?: "create-response-lost" | "switch" | "delete",
	creationWait?: Promise<void>,
) {
	const route = {
		schemaVersion: 1 as const,
		profileId: "local",
		revision: `sha256:${"a".repeat(64)}`,
		backend: { id: "backend:one", generation: "generation:one" },
		target: { source: "local" as const, hostId: "local" as const },
	};
	const resource = {
		resource_id: "browser:one",
		generation: "generation:one",
		workspace_id: "workspace:one",
	};
	const page = { resource, page_id: "page:one", document_revision: "1" };
	let controllerId = owned ? "view:one" : "agent:one";
	const control = () => ({
		resource,
		revision: "1",
		phase: "ready",
		controller: { resource, controller_id: controllerId, epoch: "1" },
		requested_controller: null,
		in_flight: null,
		next_command_sequence: "1",
		current_page: page,
	});
	const actions: Record<string, unknown>[] = [];
	const catalog = [
		{
			profile: {
				profileId: "default",
				label: "Default",
				scope: "default",
				userAgentMode: "clean",
			},
			state: "active",
		},
		{
			profile: {
				profileId: "profile:next",
				label: "개인 작업",
				scope: "isolated",
				userAgentMode: "native",
			},
			state: "active",
		},
		{
			profile: {
				profileId: "profile:gone",
				label: "Deleted",
				scope: "isolated",
				userAgentMode: "clean",
			},
			state: "deleted",
		},
	];
	const invoke = vi.fn(async (_command, args) => {
		const body = args.body;
		let result: unknown;
		if (body.kind === "observe")
			result = {
				control: control(),
				pages: [
					{
						page,
						url: "https://example.com/",
						title: "Source",
						profile_id: "default",
					},
				],
			};
		else if (body.kind === "frame")
			result = {
				page,
				mimeType: "image/jpeg",
				base64: "aW1hZ2U=",
				viewport: { width: 400, height: 600, pixel_ratio: 1 },
			};
		else if (body.kind === "profile_list") result = { profiles: catalog };
		else if (body.kind === "profile_create") {
			actions.push(body);
			const record = {
				profile: {
					profileId: "profile:created",
					label: body.label,
					scope: body.scope,
					userAgentMode: body.user_agent_mode,
				},
				state: "active",
			};
			catalog.push(record);
			await creationWait;
			if (fault === "create-response-lost")
				throw new Error("response lost after creation");
			result = { profile: record };
		} else if (body.kind === "profile_delete") {
			actions.push(body);
			const row = catalog.find(
				(row) => row.profile.profileId === body.profile_id,
			);
			if (row) row.state = fault === "delete" ? "retiring" : "deleted";
			if (fault === "delete") throw new Error("retirement interrupted");
			result = { profile_id: body.profile_id, deleted: !!row };
		} else if (body.kind === "profile_set" || body.kind === "profile_clone") {
			actions.push(body);
			const changed = {
				...page,
				page_id: body.kind === "profile_clone" ? "page:clone" : page.page_id,
				document_revision: "2",
			};
			result = {
				control: {
					...control(),
					revision: "2",
					next_command_sequence: "2",
					current_page: changed,
				},
				observation: null,
				response: {
					success: fault !== "switch",
					data: {
						page: changed,
						profile_id: body.profile_id,
						source_page: page,
					},
				},
			};
		} else throw new Error(`Unexpected request ${body.kind}`);
		return {
			schemaVersion: 1,
			backendId: route.backend.id,
			backendGeneration: route.backend.generation,
			routeAuthority: route,
			result: {
				schemaVersion: 1,
				operation_id: body.operation_id ?? body.authority?.operation_id ?? null,
				result,
			},
		};
	});
	const session = new BrowserPaneSession(
		createDureBrowserClient(route, invoke),
		resource,
		"view:one",
		undefined,
		async () => "image",
	);
	await session.refresh();
	const mounted = render(
		<BrowserProfileDialog
			session={session}
			view={session.read()}
			enabled={owned}
			onProfileDeleted={() => session.refresh()}
		/>,
	);
	fireEvent.click(
		screen.getByRole("button", { name: "panels.browser.profiles" }),
	);
	await waitFor(() => expect(screen.getByRole("combobox").hasAttribute("disabled")).toBe(false));
	openSelect(screen.getByRole("combobox"));
	await screen.findByRole("option", { name: "개인 작업" });
	expect(screen.queryByRole("option", { name: "Deleted" })).toBeNull();
	fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
	return {
		actions,
		invoke,
		session,
		mounted,
		page,
		control,
		changeController: () => {
			controllerId = "agent:replacement";
		},
	};
}

it.each(["profileSwitch", "profileClone"] as const)(
	"submits %s only after choosing a profile and confirming the exact page",
	async (button) => {
		const state = await fixture();
		try {
			expect(state.actions).toEqual([]);
			chooseSelectValue(screen.getByRole("combobox", {
					name: "panels.browser.profileDestination",
				}), "profile:next");
			expect(state.actions).toEqual([]);
			fireEvent.click(
				screen.getByRole("button", { name: `panels.browser.${button}` }),
			);
			await waitFor(() => expect(state.actions).toHaveLength(1));
			expect(state.actions[0]).toMatchObject({
				kind: button === "profileSwitch" ? "profile_set" : "profile_clone",
				caller: "view:one",
				profile_id: "profile:next",
				authority: {
					page: state.page,
					lease: state.control().controller,
					command_sequence: "1",
				},
			});
			await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		} finally {
			state.mounted.unmount();
			await state.session.dispose(false);
		}
	},
);

it("lets an observer read profiles without requesting control or changing the page", async () => {
	const state = await fixture(false);
	try {
		chooseSelectValue(screen.getByRole("combobox", {
				name: "panels.browser.profileDestination",
			}), "profile:next");
		for (const key of [
			"profileSwitch",
			"profileClone",
			"newProfile",
			"deleteProfile",
		]) {
			const button = screen.getByRole("button", {
				name: `panels.browser.${key}`,
			});
			expect(button).toHaveProperty("disabled", true);
			fireEvent.click(button);
		}
		expect(state.actions).toEqual([]);
		expect(
			state.invoke.mock.calls.some(([, args]) => args.body.kind === "control"),
		).toBe(false);
	} finally {
		state.mounted.unmount();
		await state.session.dispose(false);
	}
});

it("rejects an old confirmation after the session observes a new controller", async () => {
	const state = await fixture();
	try {
		chooseSelectValue(screen.getByRole("combobox", {
				name: "panels.browser.profileDestination",
			}), "profile:next");
		state.changeController();
		await state.session.refresh();
		fireEvent.click(
			screen.getByRole("button", { name: "panels.browser.profileSwitch" }),
		);
		expect(state.actions).toEqual([]);
	} finally {
		state.mounted.unmount();
		await state.session.dispose(false);
	}
});

it("creates an isolated profile with the chosen policy and then switches the admitted page", async () => {
	const state = await fixture();
	try {
		fireEvent.click(
			screen.getByRole("button", { name: "panels.browser.newProfile" }),
		);
		fireEvent.change(
			screen.getByRole("textbox", { name: "panels.browser.profileName" }),
			{ target: { value: "  새 프로필  " } },
		);
		fireEvent.click(
			screen.getByRole("switch", { name: "panels.browser.nativeUserAgent" }),
		);
		expect(state.actions).toEqual([]);
		fireEvent.click(
			screen.getByRole("button", {
				name: "panels.browser.createProfileAndSwitch",
			}),
		);
		await waitFor(() => expect(state.actions).toHaveLength(2));
		expect(state.actions[0]).toMatchObject({
			kind: "profile_create",
			label: "새 프로필",
			scope: "isolated",
			user_agent_mode: "native",
		});
		expect(state.actions[1]).toMatchObject({
			kind: "profile_set",
			profile_id: "profile:created",
			authority: { page: state.page, lease: state.control().controller },
		});
		expect(state.actions[0].operation_id).toEqual(expect.any(String));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	} finally {
		state.mounted.unmount();
		await state.session.dispose(false);
	}
});

it("protects default and deletes the exact selected profile only after confirmation", async () => {
	const state = await fixture();
	try {
		expect(
			screen.getByRole("button", { name: "panels.browser.deleteProfile" }),
		).toHaveProperty("disabled", true);
		chooseSelectValue(screen.getByRole("combobox", {
				name: "panels.browser.profileDestination",
			}), "profile:next");
		fireEvent.click(
			screen.getByRole("button", { name: "panels.browser.deleteProfile" }),
		);
		expect(state.actions).toEqual([]);
		fireEvent.click(screen.getByRole("button", { name: "common.cancel" }));
		expect(state.actions).toEqual([]);
		fireEvent.click(
			screen.getByRole("button", { name: "panels.browser.deleteProfile" }),
		);
		fireEvent.click(
			screen.getByRole("button", {
				name: "panels.browser.confirmDeleteProfile",
			}),
		);
		await waitFor(() => expect(state.actions).toHaveLength(1));
		expect(state.actions[0]).toMatchObject({
			kind: "profile_delete",
			profile_id: "profile:next",
			operation_id: expect.any(String),
		});
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		fireEvent.click(screen.getByRole("button", { name: "panels.browser.profiles" }));
		await waitFor(() => expect(screen.getByRole("combobox").hasAttribute("disabled")).toBe(false));
		openSelect(screen.getByRole("combobox"));
		expect(screen.queryByRole("option", { name: "개인 작업" })).toBeNull();
		fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
	} finally {
		state.mounted.unmount();
		await state.session.dispose(false);
	}
});

it.each(["create-response-lost", "switch"] as const)(
	"does not repeat creation after %s and distinguishes a saved profile",
	async (fault) => {
		const state = await fixture(true, fault);
		try {
			fireEvent.click(
				screen.getByRole("button", { name: "panels.browser.newProfile" }),
			);
			fireEvent.change(
				screen.getByRole("textbox", { name: "panels.browser.profileName" }),
				{ target: { value: "새 프로필" } },
			);
			fireEvent.click(
				screen.getByRole("button", {
					name: "panels.browser.createProfileAndSwitch",
				}),
			);
			await screen.findByText(
				fault === "switch"
					? "panels.browser.profileCreatedSwitchFailed"
					: "ipc.browser.requestFailed",
			);
			expect(
				state.actions.filter((row) => row.kind === "profile_create"),
			).toHaveLength(1);
			expect(
				state.actions.filter((row) => row.kind === "profile_set"),
			).toHaveLength(fault === "switch" ? 1 : 0);
			if (fault === "switch")
				expect(screen.getByRole("combobox").textContent).toBe("새 프로필");
			else {
				const button = screen.getByRole("button", {
					name: "panels.browser.createProfileAndSwitch",
				});
				expect(button).toHaveProperty("disabled", true);
				fireEvent.click(button);
				expect(state.actions).toHaveLength(1);
			}
		} finally {
			state.mounted.unmount();
			await state.session.dispose(false);
		}
	},
);

it("keeps interrupted retirement manageable while refusing it as a page destination", async () => {
	const state = await fixture(true, "delete");
	try {
		chooseSelectValue(screen.getByRole("combobox"), "profile:next");
		fireEvent.click(
			screen.getByRole("button", { name: "panels.browser.deleteProfile" }),
		);
		fireEvent.click(
			screen.getByRole("button", {
				name: "panels.browser.confirmDeleteProfile",
			}),
		);
		await screen.findByText("ipc.browser.requestFailed");
		expect(state.actions).toHaveLength(1);
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		fireEvent.click(
			screen.getByRole("button", { name: "panels.browser.profiles" }),
		);
		await waitFor(() => expect(screen.getByRole("combobox").hasAttribute("disabled")).toBe(false));
		openSelect(screen.getByRole("combobox"));
		await screen.findByRole("option", {
			name: "panels.browser.profileRetiring",
		});
		fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
		chooseSelectValue(screen.getByRole("combobox"), "profile:next");
		expect(
			screen.getByRole("button", { name: "panels.browser.profileSwitch" }),
		).toHaveProperty("disabled", true);
		expect(
			screen.getByRole("button", { name: "panels.browser.profileClone" }),
		).toHaveProperty("disabled", true);
		expect(
			screen.getByRole("button", { name: "panels.browser.deleteProfile" }),
		).toHaveProperty("disabled", false);
		expect(state.actions).toHaveLength(1);
	} finally {
		state.mounted.unmount();
		await state.session.dispose(false);
	}
});

it("does not switch a newly saved profile after the controller changed while creating it", async () => {
	let release!: () => void;
	const waiting = new Promise<void>((resolve) => {
		release = resolve;
	});
	const state = await fixture(true, undefined, waiting);
	try {
		fireEvent.click(
			screen.getByRole("button", { name: "panels.browser.newProfile" }),
		);
		fireEvent.change(
			screen.getByRole("textbox", { name: "panels.browser.profileName" }),
			{ target: { value: "Saved for later" } },
		);
		fireEvent.click(
			screen.getByRole("button", {
				name: "panels.browser.createProfileAndSwitch",
			}),
		);
		await waitFor(() => expect(state.actions).toHaveLength(1));
		state.changeController();
		await state.session.refresh();
		release();
		await screen.findByText("panels.browser.profileCreatedSwitchFailed");
		expect(state.actions.map((row) => row.kind)).toEqual(["profile_create"]);
		expect(screen.getByRole("combobox").textContent).toBe("Saved for later");
	} finally {
		release();
		state.mounted.unmount();
		await state.session.dispose(false);
	}
});
