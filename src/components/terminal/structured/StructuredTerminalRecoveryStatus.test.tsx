// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ManagedCreateRetrySameError } from "@/lib/hmux/managed/managedCreateResolution";
import { t } from "@/lib/i18n";
import { paneActionSnapshot } from "@/lib/workspace/pane/paneActionRegistry";
import { StructuredTerminalRecoveryStatus } from "./StructuredTerminalRecoveryStatus";

afterEach(cleanup);

it.each(["committed", "failed"])(
	"waits for the owning replacement before automatic Resume (%s)",
	async (outcome) => {
		const resume = vi.fn(async () => {});
		const attachRecovery = {
			intent: "resume" as const,
			ownerKey: "fixture-runtime",
			context: "pane=agent:replacing",
			resume,
			automatic: true,
			transitioning: true,
		};
		const view = render(
			<StructuredTerminalRecoveryStatus
				paneId="agent:replacing"
				error="session_exited"
				attachRecovery={attachRecovery}
			/>,
		);
		expect(screen.queryByRole("status")).toBeNull();
		expect(screen.queryByText(t("terminal.recovery.title"))).toBeNull();
		expect(resume).not.toHaveBeenCalled();
		expect(paneActionSnapshot("agent:replacing")?.actions).toEqual([]);
		await act(async () =>
			view.rerender(
				<StructuredTerminalRecoveryStatus
					paneId="agent:replacing"
					error={outcome === "failed" ? "session_exited" : undefined}
					attachRecovery={{ ...attachRecovery, transitioning: false }}
				/>,
			),
		);
		expect(resume).toHaveBeenCalledTimes(outcome === "failed" ? 1 : 0);
	},
);

it.each([
	{ surface: undefined, paints: "bg-surface-terminal" },
	{ surface: "pane" as const, paints: "bg-surface-pane" },
])("the detached cover paints its host's surface ($paints)", ({ surface, paints }) => {
	render(
		<StructuredTerminalRecoveryStatus
			paneId="agent:cover"
			error="session_exited"
			attachRecovery={{
				intent: "resume" as const,
				ownerKey: "fixture-runtime",
				context: "pane=agent:cover",
				resume: vi.fn(async () => {}),
				automatic: false,
				transitioning: false,
			}}
			surface={surface}
		/>,
	);
	const cover = screen.getByRole("status").closest(".absolute.inset-0") as HTMLElement;
	expect(cover.className).toContain(paints);
});

it.each([
	{
		cause: new ManagedCreateRetrySameError(
			"create_retryable",
			"session_checkout_store_busy",
			"store is busy during prepare_session_checkout",
		),
		shown: "terminal.recovery.resumeBusy",
		hidden: "terminal.recovery.resumeFailed",
	},
	{
		cause: new Error("store is busy during prepare_session_checkout"),
		shown: "terminal.recovery.resumeFailed",
		hidden: "terminal.recovery.resumeBusy",
	},
])(
	"a refused automatic Resume says why ($shown) and keeps the raw cause in the details",
	async ({ cause, shown, hidden }) => {
		const resume = vi.fn(async () => {
			throw cause;
		});
		render(
			<StructuredTerminalRecoveryStatus
				paneId="agent:busy"
				error="session_exited"
				attachRecovery={{
					intent: "resume" as const,
					ownerKey: "fixture-runtime",
					context: "pane=agent:busy",
					resume,
					automatic: true,
					transitioning: false,
				}}
				surface="pane"
			/>,
		);
		expect(await screen.findByText(t(shown))).toBeTruthy();
		expect(screen.queryByText(t(hidden))).toBeNull();
		expect(resume).toHaveBeenCalledOnce();
		expect(screen.queryByText(/store is busy/)).toBeNull();
		await act(async () =>
			screen.getByRole("button", { name: t("terminal.recovery.viewDetails") }).click(),
		);
		expect(
			screen.getByText(/store is busy during prepare_session_checkout/).textContent,
		).toContain("session_exited");
	},
);

it("a sign-in exit does not self-heal and offers the pane's sign-in recovery", async () => {
	const resume = vi.fn(async () => {});
	const signIn = vi.fn();
	const switchAccount = vi.fn();
	render(
		<StructuredTerminalRecoveryStatus
			paneId="agent:sign-in"
			error="Managed provider exited with status 1 at its sign-in screen."
			signInRequired
			attachRecovery={{
				intent: "start_fresh" as const,
				ownerKey: "fixture-runtime",
				context: "pane=agent:sign-in",
				resume,
				automatic: true,
				transitioning: false,
				signIn: { accountName: "Work", signIn, switchAccount },
			}}
		/>,
	);
	// Starting the same signed-out account again would park on the same
	// sign-in screen, so the one-shot self-heal stays off.
	expect(resume).not.toHaveBeenCalled();
	expect(screen.getByText(t("terminal.recovery.signInTitle"))).toBeTruthy();
	expect(
		screen.getByText(t("terminal.recovery.signInBody", { account: "Work" })),
	).toBeTruthy();
	expect(paneActionSnapshot("agent:sign-in")?.actions).toEqual(
		expect.arrayContaining(["start_fresh", "sign_in", "switch_account"]),
	);
	await act(async () =>
		screen.getByRole("button", { name: t("agents.chat.recovery.signIn") }).click(),
	);
	expect(signIn).toHaveBeenCalledOnce();
	await act(async () =>
		screen
			.getByRole("button", { name: t("agents.chat.recovery.chooseAccount") })
			.click(),
	);
	expect(switchAccount).toHaveBeenCalledOnce();
	expect(resume).not.toHaveBeenCalled();
});

it("a sign-in exit without pane recovery still skips self-healing", () => {
	const resume = vi.fn(async () => {});
	render(
		<StructuredTerminalRecoveryStatus
			paneId="terminal:sign-in"
			error="Managed provider exited at its sign-in screen."
			signInRequired
			attachRecovery={{
				intent: "start_fresh" as const,
				ownerKey: "fixture-runtime",
				context: "pane=terminal:sign-in",
				resume,
				automatic: true,
				transitioning: false,
			}}
		/>,
	);
	expect(resume).not.toHaveBeenCalled();
	expect(screen.getByText(t("terminal.recovery.signInBodyUnnamed"))).toBeTruthy();
	expect(
		screen.queryByRole("button", { name: t("agents.chat.recovery.signIn") }),
	).toBeNull();
});
