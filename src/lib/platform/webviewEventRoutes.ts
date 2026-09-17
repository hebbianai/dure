import type { UnlistenFn } from "@tauri-apps/api/event";

type RouteHandler<Payload> = (payload: Payload) => void;

interface RouteRegistration<Payload> {
	handler: RouteHandler<Payload>;
}

/**
 * Separates one retained native subscription from replaceable local routes.
 * Removing a local registration never tears down the native callback.
 */
export class WebviewEventRoutes<Envelope, Payload> {
	private readonly routes = new Map<string, Set<RouteRegistration<Payload>>>();
	private nativeSubscription: Promise<UnlistenFn> | undefined;

	constructor(
		private readonly subscribeNative: (
			handler: RouteHandler<Envelope>,
		) => Promise<UnlistenFn>,
		private readonly routeId: (envelope: Envelope) => string,
		private readonly payload: (envelope: Envelope) => Payload,
	) {}

	async subscribe(
		routeId: string,
		handler: RouteHandler<Payload>,
	): Promise<UnlistenFn> {
		const registration = { handler };
		const registrations = this.routes.get(routeId) ?? new Set();
		registrations.add(registration);
		this.routes.set(routeId, registrations);
		try {
			await this.ensureNativeSubscription();
		} catch (error) {
			this.remove(routeId, registration);
			throw error;
		}

		let active = true;
		return () => {
			if (!active) return;
			active = false;
			this.remove(routeId, registration);
		};
	}

	private ensureNativeSubscription(): Promise<UnlistenFn> {
		if (this.nativeSubscription) return this.nativeSubscription;
		const subscription = this.subscribeNative((envelope) => {
			const registrations = this.routes.get(this.routeId(envelope));
			if (!registrations) return;
			const payload = this.payload(envelope);
			for (const { handler } of [...registrations]) handler(payload);
		});
		this.nativeSubscription = subscription;
		void subscription.catch(() => {
			if (this.nativeSubscription === subscription) {
				this.nativeSubscription = undefined;
			}
		});
		return subscription;
	}

	private remove(
		routeId: string,
		registration: RouteRegistration<Payload>,
	): void {
		const registrations = this.routes.get(routeId);
		if (!registrations) return;
		registrations.delete(registration);
		if (registrations.size === 0) this.routes.delete(routeId);
	}
}
