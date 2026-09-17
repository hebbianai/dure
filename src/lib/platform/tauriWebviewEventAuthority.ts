import type {
	Event,
	EventCallback,
	EventName,
	EventTarget,
	Options,
	UnlistenFn,
} from "@tauri-apps/api/event";
import { WebviewEventRoutes } from "./webviewEventRoutes";

type RawEventListener = (
	event: EventName,
	handler: EventCallback<unknown>,
	options?: Options,
) => Promise<UnlistenFn>;

const LOCAL_EVENT_ROUTE = "event";

function targetIdentity(target: Options["target"]): string {
	if (target === undefined) return "Any";
	if (typeof target === "string") return `AnyLabel:${target}`;
	if ("label" in target) return `${target.kind}:${target.label}`;
	return target.kind;
}

function tauriEventRouteIdentity(
	event: EventName,
	target?: string | EventTarget,
): string {
	return JSON.stringify([event, targetIdentity(target)]);
}

/** One event/target subscription table for a WebView JavaScript realm. */
export class TauriWebviewEventAuthority {
	private readonly retainedRoutes = new Map<
		string,
		WebviewEventRoutes<Event<unknown>, Event<unknown>>
	>();

	constructor(private readonly listenNative: RawEventListener) {}

	subscribe<T>(
		event: EventName,
		handler: EventCallback<T>,
		options?: Options,
	): Promise<UnlistenFn> {
		const identity = tauriEventRouteIdentity(event, options?.target);
		let routes = this.retainedRoutes.get(identity);
		if (!routes) {
			const nativeOptions = options?.target !== undefined
				? { target: options.target }
				: undefined;
			routes = new WebviewEventRoutes(
				(dispatch) => this.listenNative(event, dispatch, nativeOptions),
				() => LOCAL_EVENT_ROUTE,
				(nativeEvent) => nativeEvent,
			);
			this.retainedRoutes.set(identity, routes);
		}
		return routes.subscribe(
			LOCAL_EVENT_ROUTE,
			handler as EventCallback<unknown>,
		);
	}
}
