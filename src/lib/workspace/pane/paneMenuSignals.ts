// PaneChrome(⋮ 드롭다운) 항목이 pane 내부 컴포넌트가 소유한 메뉴/dialog를 여는
// 신호. 대화 기록과 작업 위임은 데이터 로드·복구 흐름이 AgentPanel에 강결합이라
// (teardown·remount·재spawn) 로직을 옮기는 대신 트리거만 옮긴다.
type Listener = () => void;
const conversationHistoryListeners = new Map<string, Set<Listener>>();
const delegateTaskListeners = new Map<string, Set<Listener>>();
const managedRecoveryListeners = new Map<string, Set<Listener>>();

function request(listeners: Map<string, Set<Listener>>, panelId: string): void {
	for (const listener of listeners.get(panelId) ?? []) listener();
}

function subscribe(
	listeners: Map<string, Set<Listener>>,
	panelId: string,
	listener: Listener,
): () => void {
	const set = listeners.get(panelId) ?? new Set<Listener>();
	set.add(listener);
	listeners.set(panelId, set);
	return () => {
		set.delete(listener);
		if (set.size === 0) listeners.delete(panelId);
	};
}

export function requestConversationHistoryMenu(panelId: string): void {
	request(conversationHistoryListeners, panelId);
}

export function subscribeConversationHistoryMenu(
	panelId: string,
	listener: Listener,
): () => void {
	return subscribe(conversationHistoryListeners, panelId, listener);
}

export function requestDelegateTaskDialog(panelId: string): void {
	request(delegateTaskListeners, panelId);
}

export function subscribeDelegateTaskDialog(
	panelId: string,
	listener: Listener,
): () => void {
	return subscribe(delegateTaskListeners, panelId, listener);
}

export function requestManagedRecovery(panelId: string): void {
	request(managedRecoveryListeners, panelId);
}

export function subscribeManagedRecovery(
	panelId: string,
	listener: Listener,
): () => void {
	return subscribe(managedRecoveryListeners, panelId, listener);
}
