import { message as messageDialog } from "@tauri-apps/plugin-dialog";
import { useCallback } from "react";
import { useRuntimeOwnedValue } from "@/components/agents/useRuntimeOwnedValue";
import type { AgentPanelDockProps } from "@/components/panels/agentPanelContract";
import { agentRuntimePresentationOwnerKey } from "@/lib/agents/agentRuntimePresentationOwner";
import { remoteAccountDir } from "@/lib/agents/providers";
import {
	preflightRemoteAccountLaunch,
	prepareRemoteAccountLogin,
} from "@/lib/agents/remoteAccountOverlay";
import { t } from "@/lib/i18n";
import { hostToOpts, sshCopyAccount } from "@/lib/ipc";
import { openRemoteSshTerminalOn } from "@/lib/workspace/dock";
import type { AccountProfile, Agent, SshHostConfig } from "@/types";

export function useRemoteAgentCredentialActions({
	agent,
	host,
	containerApi,
}: {
	agent: Agent;
	host?: SshHostConfig;
	containerApi: AgentPanelDockProps["containerApi"];
}) {
	const runtimeOwnerKey = agentRuntimePresentationOwnerKey(agent);
	const [ownedBusy, setBusy] =
		useRuntimeOwnedValue<boolean>(runtimeOwnerKey);
	const busy = ownedBusy ?? false;

	const openRemoteLogin = useCallback(
		async (account: AccountProfile) => {
			if (!host) return;
			try {
				const commandLine = await prepareRemoteAccountLogin(
					host,
					agent.worktreePath,
					account,
				);
				openRemoteSshTerminalOn(
					containerApi,
					host.id,
					host.name,
					undefined,
					undefined,
					{
						commandLine,
						title: t("common.loginWithName", { name: account.name }),
					},
				);
			} catch (error) {
				await messageDialog(String(error), {
					title: t("panels.agent.account.loginFailed"),
					kind: "error",
				});
			}
		},
		[agent.worktreePath, containerApi, host],
	);

	const copyAccountToHost = useCallback(
		async (account: AccountProfile) => {
			if (!host || busy) return;
			setBusy(true);
			try {
				await preflightRemoteAccountLaunch(
					host,
					account.provider,
					agent.worktreePath,
					account,
					{ requireCredential: false },
				);
				const copied = await sshCopyAccount(
					hostToOpts(host),
					account.provider,
					account.dir,
					remoteAccountDir(account),
				);
				await messageDialog(
					t("panels.agent.account.copied", {
						name: account.name,
						host: host.name,
						files: copied.join(", "),
					}),
				);
			} catch (error) {
				await messageDialog(String(error), {
					title: t("panels.agent.account.copyFailed"),
					kind: "error",
				});
			} finally {
				setBusy(false);
			}
		},
		[agent.worktreePath, busy, host, setBusy],
	);

	return { busy, openRemoteLogin, copyAccountToHost };
}
