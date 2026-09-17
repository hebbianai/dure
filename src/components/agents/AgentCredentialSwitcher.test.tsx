// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentCredentialSwitcher } from "@/components/agents/AgentCredentialSwitcher";
import { t } from "@/lib/i18n";
import { beginManagedCredentialSwitchTransition } from "@/lib/sessions/managed/managedCredentialSwitchTransition";

afterEach(cleanup);

describe("AgentCredentialSwitcher", () => {
	it("announces both an immediate request and an automatic replacement without waiting for a hover", () => {
		const props = {
			agentId: "agent-feedback",
			provider: "codex" as const,
			accounts: [],
			followsGlobal: false,
			accountBusy: true,
			disabled: true,
			disabledTitle: "Pane account",
			onSwitch: vi.fn(),
			onApplyNow: vi.fn(),
			onCancel: vi.fn(),
			onRemoteLogin: vi.fn(),
			onCopyToHost: vi.fn(),
			onManageAccounts: vi.fn(),
		};
		const view = render(<AgentCredentialSwitcher {...props} />);
		expect(screen.getByRole("button").getAttribute("aria-busy")).toBe("true");
		expect(screen.getByRole("status").textContent).not.toBe("");
		view.rerender(
			<AgentCredentialSwitcher
				{...props}
				accountBusy={false}
				disabled={false}
			/>,
		);
		expect(screen.queryByRole("status")).toBeNull();
		let finish: () => void = () => {};
		act(() => {
			finish = beginManagedCredentialSwitchTransition(props.agentId);
		});
		try {
			expect(screen.getByRole("button").getAttribute("aria-busy")).toBe("true");
			expect(screen.getByRole("status").textContent).not.toBe("");
		} finally {
			act(finish);
		}
		expect(screen.getByRole("button").getAttribute("aria-busy")).toBe("false");
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("keeps remote login usable before a runtime can accept account switches", async () => {
		const account = {
			id: "account-work",
			provider: "codex" as const,
			name: "Work",
			dir: "/credentials/codex-work",
		};
		const onSwitch = vi.fn();
		const onRemoteLogin = vi.fn();
		render(
			<AgentCredentialSwitcher
				provider="codex"
				accounts={[account]}
				currentAccount={account}
				followsGlobal={false}
				hostName="Build host"
				accountBusy={false}
				disabled
				disabledTitle="Runtime has not started"
				onSwitch={onSwitch}
				onApplyNow={vi.fn()}
				onCancel={vi.fn()}
				onRemoteLogin={onRemoteLogin}
				onCopyToHost={vi.fn()}
				onManageAccounts={vi.fn()}
			/>,
		);
		fireEvent.pointerDown(screen.getByRole("button"), {
			button: 0,
			ctrlKey: false,
			pointerType: "mouse",
		});
		const login = await screen.findByRole("menuitem", {
			name: t("agents.account.loginOnHost"),
		});
		const switchDefault = screen.getByRole("menuitem", {
			name: t("agents.account.defaultCli"),
		});
		expect(switchDefault.getAttribute("aria-disabled")).toBe("true");
		fireEvent.click(switchDefault);
		expect(onSwitch).not.toHaveBeenCalled();
		fireEvent.click(login);
		expect(onRemoteLogin).toHaveBeenCalledWith(account);
	});

	it("does not request a switch when the effective account is selected again", async () => {
		const onSwitch = vi.fn();
		render(
			<AgentCredentialSwitcher
				provider="codex"
				accounts={[
					{
						id: "account-current",
						provider: "codex",
						name: "develop.clink",
						dir: "/credentials/develop",
					},
					{
						id: "account-other",
						provider: "codex",
						name: "crispy0417",
						dir: "/credentials/crispy",
					},
				]}
				currentAccount={{
					id: "account-current",
					provider: "codex",
					name: "develop.clink",
					dir: "/credentials/develop",
				}}
				followsGlobal
				accountBusy={false}
				disabled={false}
				disabledTitle="Pane account"
				onSwitch={onSwitch}
				onApplyNow={vi.fn()}
				onCancel={vi.fn()}
				onRemoteLogin={vi.fn()}
				onCopyToHost={vi.fn()}
				onManageAccounts={vi.fn()}
			/>,
		);

		fireEvent.pointerDown(
			screen.getByRole("button", { name: "Pane account" }),
			{ button: 0, ctrlKey: false, pointerType: "mouse" },
		);
		fireEvent.click(
			await screen.findByRole("menuitem", { name: /develop\.clink/ }),
		);

		expect(onSwitch).not.toHaveBeenCalled();

		fireEvent.pointerDown(
			screen.getByRole("button", { name: "Pane account" }),
			{ button: 0, ctrlKey: false, pointerType: "mouse" },
		);
		fireEvent.click(
			await screen.findByRole("menuitem", { name: "crispy0417" }),
		);
		expect(onSwitch).toHaveBeenCalledOnce();
		expect(onSwitch).toHaveBeenCalledWith("account-other");
	});

	it("requests the current account again when credential recovery is enabled", async () => {
		const currentAccount = {
			id: "hebbian98",
			provider: "claude" as const,
			name: "hebbian98",
			dir: "/credentials/hebbian98",
		};
		const onSwitch = vi.fn();
		render(
			<AgentCredentialSwitcher
				provider="claude"
				accounts={[currentAccount]}
				currentAccount={currentAccount}
				followsGlobal={false}
				accountBusy={false}
				disabled={false}
				disabledTitle="Pane account"
				allowCurrentAccountReselect
				onSwitch={onSwitch}
				onApplyNow={vi.fn()}
				onCancel={vi.fn()}
				onRemoteLogin={vi.fn()}
				onCopyToHost={vi.fn()}
				onManageAccounts={vi.fn()}
			/>,
		);

		fireEvent.pointerDown(
			screen.getByRole("button", { name: "Pane account" }),
			{ button: 0, ctrlKey: false },
		);
		fireEvent.click(await screen.findByRole("menuitem", { name: /hebbian98/ }));

		expect(onSwitch).toHaveBeenCalledOnce();
		expect(onSwitch).toHaveBeenCalledWith("hebbian98");
	});

	it("collapses the ordinary account label before pane status summaries", () => {
		render(
			<AgentCredentialSwitcher
				provider="codex"
				accounts={[
					{
						id: "account-1",
						provider: "codex",
						name: "crispy",
						dir: "/credentials/crispy",
					},
				]}
				currentAccount={{
					id: "account-1",
					provider: "codex",
					name: "crispy",
					dir: "/credentials/crispy",
				}}
				followsGlobal={false}
				accountBusy={false}
				disabled={false}
				disabledTitle="이 pane에서 쓸 계정"
				onSwitch={vi.fn()}
				onApplyNow={vi.fn()}
				onCancel={vi.fn()}
				onRemoteLogin={vi.fn()}
				onCopyToHost={vi.fn()}
				onManageAccounts={vi.fn()}
			/>,
		);

		const trigger = screen.getByRole("button", { name: "이 pane에서 쓸 계정" });
		expect(trigger.getAttribute("data-credential-state")).toBe("ready");
		// The label lives inside the ToolbarControl detail span. The account
		// name is reveal step 3 — it unfolds after model/effort/permissions as
		// the pane widens (2026-09-01 staggered reveal).
		expect(
			screen.getByText("crispy").closest("span[class*='@max-xl']")?.className,
		).toContain("@max-xl/agent-panel-toolbar:hidden");
	});

	it("keeps an account-switch failure inside the pane instead of opening a window", () => {
		render(
			<AgentCredentialSwitcher
				provider="codex"
				accounts={[]}
				followsGlobal={false}
				accountBusy={false}
				disabled={false}
				disabledTitle="이 pane에서 쓸 계정"
				failure="provider unavailable"
				onSwitch={vi.fn()}
				onApplyNow={vi.fn()}
				onCancel={vi.fn()}
				onRemoteLogin={vi.fn()}
				onCopyToHost={vi.fn()}
				onManageAccounts={vi.fn()}
			/>,
		);

		const trigger = screen.getByRole("button", {
			name: "계정 전환 실패: provider unavailable",
		});
		expect(trigger.getAttribute("data-credential-state")).toBe("error");
	});

	it("offers SSH recovery actions for the failed target account", async () => {
		const current = {
			id: "account-a",
			provider: "codex" as const,
			name: "account A",
			dir: "/credentials/a",
		};
		const recovery = {
			id: "account-b",
			provider: "codex" as const,
			name: "account B",
			dir: "/credentials/b",
		};
		const onRemoteLogin = vi.fn();
		render(
			<AgentCredentialSwitcher
				provider="codex"
				accounts={[current, recovery]}
				currentAccount={current}
				recoveryAccount={recovery}
				followsGlobal={false}
				failure="credential unavailable"
				hostName="build-host"
				accountBusy={false}
				disabled={false}
				disabledTitle="Pane account"
				onSwitch={vi.fn()}
				onApplyNow={vi.fn()}
				onCancel={vi.fn()}
				onRemoteLogin={onRemoteLogin}
				onCopyToHost={vi.fn()}
				onManageAccounts={vi.fn()}
			/>,
		);

		fireEvent.pointerDown(
			screen.getByRole("button", {
				name: "계정 전환 실패: credential unavailable",
			}),
			{ button: 0, ctrlKey: false },
		);
		fireEvent.click(
			await screen.findByRole("menuitem", {
				name: t("agents.account.loginOnHost"),
			}),
		);

		expect(onRemoteLogin).toHaveBeenCalledWith(recovery);
	});
});
