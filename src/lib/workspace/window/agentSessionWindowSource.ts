import { emitTo } from "@tauri-apps/api/event";
import type { HmuxAgentRuntimeState } from "@/lib/ipc";
import { listenWhenReady } from "@/lib/platform/tauriBridge";

const AGENT_SESSION_SOURCE_WINDOW_PARAM = "sourceWindow";
const AGENT_SESSION_SOURCE_PANE_PARAM = "sourcePane";
const AGENT_SESSION_SOURCE_CHANGED_EVENT =
	"dure://agent-session/source-window-changed";
const AGENT_SESSION_SOURCE_PRESENCE_EVENT =
	"dure:agent-session-source-presence-changed";
const AGENT_SESSION_RUNTIME_STATE_EVENT =
	"dure://agent-session/runtime-state-changed";
const DEFAULT_AGENT_SESSION_SOURCE_WINDOW_LABEL = "main";

export interface AgentSessionSource {
	windowLabel: string;
	paneOwnerId?: string;
}

interface StoredAgentSessionSource extends AgentSessionSource {
	open?: boolean;
}

interface AgentSessionSourceChangedPayload {
	agentId: string;
	sourceWindowLabel: string;
	sourcePaneOwnerId?: string;
}

export interface AgentSessionSourceBackend {
	emitChanged(
		targetWindowLabel: string,
		payload: AgentSessionSourceChangedPayload,
	): Promise<void>;
	listenChanged(listener: (payload: unknown) => void): Promise<() => void>;
}

interface AgentSessionRuntimeStatePayload {
	sessionId: string;
	state: HmuxAgentRuntimeState;
}

export interface AgentSessionRuntimeStateBackend {
	emitState(
		targetWindowLabel: string,
		payload: AgentSessionRuntimeStatePayload,
	): Promise<void>;
	listenState(listener: (payload: unknown) => void): Promise<() => void>;
}

const backend: AgentSessionSourceBackend = {
	emitChanged: (targetWindowLabel, payload) =>
		emitTo(
			{ kind: "WebviewWindow", label: targetWindowLabel },
			AGENT_SESSION_SOURCE_CHANGED_EVENT,
			payload,
		),
	listenChanged: (listener) =>
		listenWhenReady<unknown>(AGENT_SESSION_SOURCE_CHANGED_EVENT, (event) =>
			listener(event.payload),
		),
};

const runtimeStateBackend: AgentSessionRuntimeStateBackend = {
	emitState: (targetWindowLabel, payload) =>
		emitTo(
			{ kind: "WebviewWindow", label: targetWindowLabel },
			AGENT_SESSION_RUNTIME_STATE_EVENT,
			payload,
		),
	listenState: (listener) =>
		listenWhenReady<unknown>(AGENT_SESSION_RUNTIME_STATE_EVENT, (event) =>
			listener(event.payload),
		),
};

function validIdentifier(value: unknown, maximumLength = 512): value is string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > maximumLength
	) {
		return false;
	}
	for (const character of value) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (codePoint <= 0x1f || codePoint === 0x7f) return false;
	}
	return true;
}

function sourceStorageKey(agentId: string): string {
	return `dure:agent-session-source:${agentId}`;
}

function notifyPresenceChanged(agentId: string): void {
	window.dispatchEvent(
		new CustomEvent(AGENT_SESSION_SOURCE_PRESENCE_EVENT, {
			detail: { agentId },
		}),
	);
}

export function normalizeAgentSessionSourceWindowLabel(value: unknown): string {
	return validIdentifier(value, 128)
		? value
		: DEFAULT_AGENT_SESSION_SOURCE_WINDOW_LABEL;
}

export function normalizeAgentSessionSourcePaneOwnerId(
	value: unknown,
): string | undefined {
	return validIdentifier(value) ? value : undefined;
}

function normalizedSource(source: AgentSessionSource): AgentSessionSource {
	const paneOwnerId = normalizeAgentSessionSourcePaneOwnerId(
		source.paneOwnerId,
	);
	return {
		windowLabel: normalizeAgentSessionSourceWindowLabel(source.windowLabel),
		...(paneOwnerId ? { paneOwnerId } : {}),
	};
}

export function agentSessionSourceFromSearch(
	search: string,
): AgentSessionSource {
	const params = new URLSearchParams(search);
	return normalizedSource({
		windowLabel: params.get(AGENT_SESSION_SOURCE_WINDOW_PARAM) ?? "main",
		paneOwnerId: params.get(AGENT_SESSION_SOURCE_PANE_PARAM) ?? undefined,
	});
}

export function rememberAgentSessionSource(
	agentId: string,
	source: AgentSessionSource,
): void {
	const normalized = normalizedSource(source);
	try {
		const previous = parseStoredSource(
			localStorage.getItem(sourceStorageKey(agentId)),
		);
		const open = Boolean(
			previous?.open &&
				previous.windowLabel === normalized.windowLabel &&
				previous.paneOwnerId === normalized.paneOwnerId,
		);
		localStorage.setItem(
			sourceStorageKey(agentId),
			JSON.stringify({ ...normalized, open }),
		);
		notifyPresenceChanged(agentId);
	} catch {
		// The URL and live event remain authoritative when storage is unavailable.
	}
}

function parseStoredSource(
	value: string | null,
): StoredAgentSessionSource | undefined {
	if (!value) return undefined;
	try {
		const parsed = JSON.parse(value) as Record<string, unknown>;
		if (!validIdentifier(parsed.windowLabel, 128)) return undefined;
		return {
			...normalizedSource({
				windowLabel: parsed.windowLabel,
				paneOwnerId: normalizeAgentSessionSourcePaneOwnerId(
					parsed.paneOwnerId,
				),
			}),
			open: parsed.open === true,
		};
	} catch {
		// Before exact-pane routing, this key contained only the source label.
		return validIdentifier(value, 128) ? { windowLabel: value } : undefined;
	}
}

export function setAgentSessionSourceOpen(
	agentId: string,
	source: AgentSessionSource,
	open: boolean,
): void {
	try {
		localStorage.setItem(
			sourceStorageKey(agentId),
			JSON.stringify({ ...normalizedSource(source), open }),
		);
		notifyPresenceChanged(agentId);
	} catch {
		// A source pane can still recover by opening or focusing the native window.
	}
}

export function agentSessionSourceIsOpen(
	agentId: string,
	source: AgentSessionSource,
): boolean {
	try {
		const stored = parseStoredSource(
			localStorage.getItem(sourceStorageKey(agentId)),
		);
		const normalized = normalizedSource(source);
		return Boolean(
			stored?.open &&
				stored.windowLabel === normalized.windowLabel &&
				stored.paneOwnerId === normalized.paneOwnerId,
		);
	} catch {
		return false;
	}
}

export function subscribeAgentSessionSourcePresence(
	agentId: string,
	listener: () => void,
): () => void {
	const storageKey = sourceStorageKey(agentId);
	const onStorage = (event: StorageEvent) => {
		if (event.key === storageKey) listener();
	};
	const onLocal = (event: Event) => {
		if ((event as CustomEvent).detail?.agentId === agentId) listener();
	};
	window.addEventListener("storage", onStorage);
	window.addEventListener(AGENT_SESSION_SOURCE_PRESENCE_EVENT, onLocal);
	return () => {
		window.removeEventListener("storage", onStorage);
		window.removeEventListener(AGENT_SESSION_SOURCE_PRESENCE_EVENT, onLocal);
	};
}

export function currentAgentSessionSource(
	agentId: string,
	fallback: AgentSessionSource,
): AgentSessionSource {
	try {
		const remembered = parseStoredSource(
			localStorage.getItem(sourceStorageKey(agentId)),
		);
		if (remembered) return normalizedSource(remembered);
	} catch {
		// Fall through to the per-window URL/event value.
	}
	return normalizedSource(fallback);
}

export async function publishAgentSessionSource(
	targetWindowLabel: string,
	agentId: string,
	source: AgentSessionSource,
	transport: AgentSessionSourceBackend = backend,
): Promise<void> {
	const normalized = normalizedSource(source);
	rememberAgentSessionSource(agentId, normalized);
	await transport.emitChanged(targetWindowLabel, {
		agentId,
		sourceWindowLabel: normalized.windowLabel,
		...(normalized.paneOwnerId
			? { sourcePaneOwnerId: normalized.paneOwnerId }
			: {}),
	});
}

export function subscribeAgentSessionSource(
	agentId: string,
	onChanged: (source: AgentSessionSource) => void,
	transport: AgentSessionSourceBackend = backend,
): () => void {
	let disposed = false;
	let stop: (() => void) | undefined;
	void transport
		.listenChanged((candidate) => {
			if (!candidate || typeof candidate !== "object") return;
			const payload = candidate as Record<string, unknown>;
			const paneOwnerId = normalizeAgentSessionSourcePaneOwnerId(
				payload.sourcePaneOwnerId,
			);
			if (
				payload.agentId !== agentId ||
				!validIdentifier(payload.sourceWindowLabel, 128) ||
				("sourcePaneOwnerId" in payload && !paneOwnerId)
			) {
				return;
			}
			const source = normalizedSource({
				windowLabel: payload.sourceWindowLabel,
				paneOwnerId,
			});
			rememberAgentSessionSource(agentId, source);
			onChanged(source);
		})
		.then((unlisten) => {
			if (disposed) unlisten();
			else stop = unlisten;
		})
		.catch(() => {});
	return () => {
		disposed = true;
		stop?.();
	};
}

export function publishAgentSessionRuntimeState(
	targetWindowLabel: string,
	sessionId: string,
	state: HmuxAgentRuntimeState,
	transport: AgentSessionRuntimeStateBackend = runtimeStateBackend,
): Promise<void> {
	return transport.emitState(targetWindowLabel, { sessionId, state });
}

export function subscribeAgentSessionRuntimeState(
	onState: (sessionId: string, state: HmuxAgentRuntimeState) => void,
	transport: AgentSessionRuntimeStateBackend = runtimeStateBackend,
): () => void {
	let disposed = false;
	let stop: (() => void) | undefined;
	void transport
		.listenState((candidate) => {
			if (!candidate || typeof candidate !== "object") return;
			const payload = candidate as Partial<AgentSessionRuntimeStatePayload>;
			if (!validIdentifier(payload.sessionId) || !payload.state) return;
			onState(payload.sessionId, payload.state);
		})
		.then((unlisten) => {
			if (disposed) unlisten();
			else stop = unlisten;
		})
		.catch(() => {});
	return () => {
		disposed = true;
		stop?.();
	};
}
