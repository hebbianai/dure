// ProviderUsageDetail's designated store-wiring point (cluster wiring hook).
// Every global-store subscription the provider usage detail surfaces need
// lives here; the components consume these hooks and keep rendering only.
// Each selector stays its own useStore subscription so rerender semantics
// match the previous inline wiring exactly.
import { useStore } from "@/store";
import type { Provider } from "@/types";

/** provider별 작업 중 에이전트 수 셀렉터 — 리터럴 분기 없이 매개변수화. */
const workingCountSelector =
	(provider: Provider) => (s: ReturnType<typeof useStore.getState>) =>
		s.agents.filter(
			(a) => a.provider === provider && s.agentActivity[a.id] === "working",
		).length;

/** 이 provider에 등록된 계정 프로필이 있는지 — 계정이 없으면 계정별 각주를
 *  띄울 이유도 없다. workingCountSelector와 같이 매개변수화한다. */
const hasAccountProfilesSelector =
	(provider: Provider) => (s: ReturnType<typeof useStore.getState>) =>
		s.accounts.some((a) => a.provider === provider);

/** Subscribed count of this provider's currently working agents. */
export function useWorkingAgentCount(provider: Provider) {
	return useStore(workingCountSelector(provider));
}

/** Whether any account profile is registered for this provider. */
export function useHasAccountProfiles(provider: Provider) {
	return useStore(hasAccountProfilesSelector(provider));
}

/** 활성 계정을 구독으로 읽는다 — activeAccount()는 getState 기반이라 전환에
 *  반응하지 않는다(계정을 바꿔도 숫자가 그대로였던 원인 중 하나). */
export function useActiveAccount(provider: Provider) {
	const activeId = useStore((s) => s.activeAccounts[provider]);
	const accounts = useStore((s) => s.accounts);
	return accounts.find((a) => a.provider === provider && a.id === activeId);
}

/** Store wiring for the credential list — accounts, the provider's active
 *  credential, the space that hosts login terminals, and the switch action. */
export function useProviderCredentialListState(provider: Provider) {
	const accounts = useStore((s) => s.accounts);
	const activeId = useStore((s) => s.activeAccounts[provider]);
	const activeSpaceId = useStore((s) => s.activeSpaceId);
	const setActiveAccount = useStore((s) => s.setActiveAccount);
	return { accounts, activeId, activeSpaceId, setActiveAccount };
}

const AGENT_PANEL_PREFIX = "agent:";

/** The focused pane's agent when it belongs to this provider, plus the
 *  active-account/accounts subscriptions the getState-based account
 *  resolution in UsageAccountRow depends on for rerenders. */
export function useUsageAccountPaneAgent(provider: Provider) {
	const paneAgent = useStore((s) => {
		const key = s.focusCtx?.key;
		const agent = key?.startsWith(AGENT_PANEL_PREFIX)
			? s.agents.find((a) => a.id === key.slice(AGENT_PANEL_PREFIX.length))
			: undefined;
		return agent?.provider === provider ? agent : undefined;
	});
	// 활성 계정 변화에도 반응해야 하므로 구독한다 (agentAccount는 getState 기반)
	useStore((s) => s.activeAccounts[provider]);
	useStore((s) => s.accounts);
	return paneAgent;
}
