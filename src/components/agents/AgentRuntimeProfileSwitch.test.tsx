// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openSelect } from "@/test/select";
import { AgentRuntimeProfileSwitch } from "@/components/agents/AgentRuntimeProfileSwitch";
import { t } from "@/lib/i18n";
import { DureAgentRuntimeSourceActiveError } from "@/lib/ipc/dureAgentRuntime";
import { DureBackendRequestError } from "@/lib/ipc/dureBackend";

function sourceActiveError() {
	return new DureAgentRuntimeSourceActiveError(
		new DureBackendRequestError(
			"agent_runtime_source_retained",
			"source retained",
			{ kind: "operation", disposition: "terminal" },
		),
	);
}


function switchVia(
	rendered: ReturnType<typeof render>,
	itemName: string,
) {
	openSelect(rendered.getByRole("combobox", { name: t("agents.runtime.viewLabel") }));
	fireEvent.click(rendered.getByRole("option", { name: itemName }));
}

describe("AgentRuntimeProfileSwitch", () => {
	afterEach(cleanup);

	it("locks the action while the durable replacement is in flight", async () => {
		let resolve!: () => void;
		const onSwitch = vi.fn(
			() =>
				new Promise<void>((done) => {
					resolve = done;
				}),
		);
		const rendered = render(
			<AgentRuntimeProfileSwitch sourceRevision={1} onSwitch={onSwitch} />,
		);
		switchVia(rendered, t("agents.runtime.chatTarget"));

		const pending = rendered.getByRole("combobox", {
			name: t("agents.runtime.viewLabel"),
		});
		expect(pending.textContent).toContain(
			t("agents.runtime.switchingToChat"),
		);
		expect(pending.hasAttribute("disabled")).toBe(true);
		fireEvent.click(pending);
		expect(onSwitch).toHaveBeenCalledOnce();

		resolve();
		await waitFor(() =>
			expect(
				rendered
					.getByRole("combobox", {
						name: t("agents.runtime.viewLabel"),
					})
					.hasAttribute("disabled"),
			).toBe(false),
		);
	});

	it("keeps the same action available after an explicit failure", async () => {
		const onSwitch = vi.fn().mockRejectedValue(new Error("source busy"));
		const rendered = render(
			<AgentRuntimeProfileSwitch sourceRevision={1} onSwitch={onSwitch} />,
		);
		switchVia(rendered, t("agents.runtime.chatTarget"));

		expect((await rendered.findByRole("alert")).textContent).toBe(
			t("agents.runtime.switchToChatFailed"),
		);
		await waitFor(() =>
			expect(
				rendered
					.getByRole("combobox", {
						name: t("agents.runtime.viewLabel"),
					})
					.hasAttribute("disabled"),
			).toBe(false),
		);
	});

	it("names and locks the Terminal replacement independently", async () => {
		let resolve!: () => void;
		const onSwitch = vi.fn(
			() =>
				new Promise<void>((done) => {
					resolve = done;
				}),
		);
		const rendered = render(
			<AgentRuntimeProfileSwitch
				sourceRevision={1}
				target="terminal"
				onSwitch={onSwitch}
			/>,
		);

		switchVia(rendered, t("common.terminal"));
		const busyTrigger = rendered.getByRole("combobox", {
			name: t("agents.runtime.viewLabel"),
		});
		expect(busyTrigger.textContent).toContain(
			t("agents.runtime.switchingToTerminal"),
		);
		expect(busyTrigger.hasAttribute("disabled")).toBe(true);

		resolve();
		await waitFor(() => expect(onSwitch).toHaveBeenCalledOnce());
	});

	it("projects the transition lifecycle to the owning conversation surface", async () => {
		let resolve!: () => void;
		const onSwitchingChange = vi.fn();
		const rendered = render(
			<AgentRuntimeProfileSwitch
				sourceRevision={1}
				onSwitch={() =>
					new Promise<void>((done) => {
						resolve = done;
					})
				}
				onSwitchingChange={onSwitchingChange}
			/>,
		);

		switchVia(rendered, t("agents.runtime.chatTarget"));
		expect(onSwitchingChange).toHaveBeenLastCalledWith(true);

		resolve();
		await waitFor(() =>
			expect(onSwitchingChange).toHaveBeenLastCalledWith(false),
		);
	});

	it("cancels a pane-local discard confirmation without another transition", async () => {
		const onSwitch = vi.fn().mockRejectedValueOnce(sourceActiveError());
		const rendered = render(
			<AgentRuntimeProfileSwitch sourceRevision={1} onSwitch={onSwitch} />,
		);

		switchVia(rendered, t("agents.runtime.chatTarget"));
		expect(
			await rendered.findByRole("heading", {
				name: t("agents.runtime.discardSourceTitle", {
					target: t("agents.runtime.chatTarget"),
				}),
			}),
		).toBeTruthy();
		expect(rendered.queryByText("source retained")).toBeNull();

		fireEvent.click(rendered.getByRole("button", { name: t("common.cancel") }));

		await waitFor(() => expect(rendered.queryByRole("dialog")).toBeNull());
		expect(onSwitch).toHaveBeenCalledTimes(1);
		expect(onSwitch).toHaveBeenCalledWith("preserve", 1);
	});

	it("reissues a fresh explicit discard transition for either target", async () => {
		const onSwitch = vi
			.fn()
			.mockRejectedValueOnce(sourceActiveError())
			.mockResolvedValueOnce(undefined);
		const rendered = render(
			<AgentRuntimeProfileSwitch
				sourceRevision={1}
				target="terminal"
				onSwitch={onSwitch}
			/>,
		);

		switchVia(rendered, t("common.terminal"));
		await rendered.findByRole("heading", {
			name: t("agents.runtime.discardSourceTitle", {
				target: t("common.terminal"),
			}),
		});
		fireEvent.click(
			rendered.getByRole("button", {
				name: t("agents.runtime.discardSourceAction"),
			}),
		);

		await waitFor(() => expect(onSwitch).toHaveBeenCalledTimes(2));
		expect(onSwitch).toHaveBeenNthCalledWith(1, "preserve", 1);
		expect(onSwitch).toHaveBeenNthCalledWith(2, "discard", 1);
		await waitFor(() => expect(rendered.queryByRole("dialog")).toBeNull());
	});

	it("confirms an unmanaged source discard without inventing a selection revision", async () => {
		const onSwitch = vi
			.fn()
			.mockRejectedValueOnce(sourceActiveError())
			.mockResolvedValueOnce(undefined);
		const rendered = render(<AgentRuntimeProfileSwitch onSwitch={onSwitch} />);

		switchVia(rendered, t("agents.runtime.chatTarget"));
		await rendered.findByRole("heading", {
			name: t("agents.runtime.discardSourceTitle", {
				target: t("agents.runtime.chatTarget"),
			}),
		});
		fireEvent.click(
			rendered.getByRole("button", {
				name: t("agents.runtime.discardSourceAction"),
			}),
		);

		await waitFor(() => expect(onSwitch).toHaveBeenCalledTimes(2));
		expect(onSwitch).toHaveBeenNthCalledWith(1, "preserve", undefined);
		expect(onSwitch).toHaveBeenNthCalledWith(2, "discard", undefined);
	});

	it("freezes discard consent to the selection revision that opened the dialog", async () => {
		const onSwitch = vi
			.fn()
			.mockRejectedValueOnce(sourceActiveError())
			.mockResolvedValueOnce(undefined);
		const rendered = render(
			<AgentRuntimeProfileSwitch sourceRevision={1} onSwitch={onSwitch} />,
		);

		switchVia(rendered, t("agents.runtime.chatTarget"));
		await rendered.findByRole("heading", {
			name: t("agents.runtime.discardSourceTitle", {
				target: t("agents.runtime.chatTarget"),
			}),
		});

		rendered.rerender(
			<AgentRuntimeProfileSwitch sourceRevision={2} onSwitch={onSwitch} />,
		);
		fireEvent.click(
			rendered.getByRole("button", {
				name: t("agents.runtime.discardSourceAction"),
			}),
		);

		await waitFor(() => expect(onSwitch).toHaveBeenCalledTimes(2));
		expect(onSwitch).toHaveBeenNthCalledWith(1, "preserve", 1);
		expect(onSwitch).toHaveBeenNthCalledWith(2, "discard", 1);
	});
});
