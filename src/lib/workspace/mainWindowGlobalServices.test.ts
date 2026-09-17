import { afterEach, expect, test, vi } from "vitest";
import { startMainWindowGlobalServices } from "@/lib/workspace/mainWindowGlobalServices";

afterEach(() => vi.restoreAllMocks());

const serviceNames = [
	"attention",
	"runtime-projection",
	"managed-agent-semantic",
	"provider-conversation-metadata",
	"notification-activation",
	"discovery-state-gc",
	"registry",
] as const;

type ServiceName = (typeof serviceNames)[number];

function lifecycleFixture(failedStart?: ServiceName) {
	const listeners = new Set<() => void>();
	const received: string[] = [];
	const stopped: string[] = [];
	const startFailure = new Error("service installation failed");
	const stopFailures = new Map<ServiceName, Error>();
	const install = (name: ServiceName) => {
		if (name === failedStart) throw startFailure;
		const listener = () => received.push(name);
		listeners.add(listener);
		return () => {
			stopped.push(name);
			const failure = stopFailures.get(name);
			if (failure) throw failure;
			listeners.delete(listener);
		};
	};
	return {
		startFailure,
		stopFailures,
		stopped,
		publish: () => {
			received.length = 0;
			for (const listener of listeners) listener();
			return [...received];
		},
		services: {
			installAttentionNotifier: () => install("attention"),
			installRuntimeProjectionReconciler: () => ({
				request: vi.fn(),
				stop: install("runtime-projection"),
			}),
			installManagedAgentSemanticObserver: () =>
				install("managed-agent-semantic"),
			installProviderConversationMetadata: () =>
				install("provider-conversation-metadata"),
			installNotificationActivation: () => install("notification-activation"),
			installDiscoveryStateGc: () => install("discovery-state-gc"),
			reconcileCanonicalStops: vi.fn(async () => undefined),
			reconcileProjects: vi.fn(async () => undefined),
			startRegistry: () => install("registry"),
		},
	};
}

test.each(serviceNames)(
	"retires earlier subscriptions if %s fails to start",
	(name) => {
		const fixture = lifecycleFixture(name);
		expect(() => startMainWindowGlobalServices(fixture.services)).toThrow(
			fixture.startFailure,
		);
		expect(fixture.publish()).toEqual([]);
		expect(fixture.services.reconcileCanonicalStops).not.toHaveBeenCalled();
	},
);

test("repeated failed startup does not accumulate active subscriptions", () => {
	const fixture = lifecycleFixture("registry");
	for (let attempt = 0; attempt < 20; attempt += 1) {
		expect(() => startMainWindowGlobalServices(fixture.services)).toThrow(
			fixture.startFailure,
		);
	}
	expect(fixture.publish()).toEqual([]);
});

test.each(["attention", "managed-agent-semantic", "registry"] as const)(
	"continues retiring independent services when %s cleanup fails",
	(name) => {
		const report = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		const fixture = lifecycleFixture();
		const failure = new Error(`${name} could not unsubscribe`);
		fixture.stopFailures.set(name, failure);
		const stop = startMainWindowGlobalServices(fixture.services);
		expect(fixture.publish()).toEqual(serviceNames);
		expect(stop).toThrow(failure);
		// A failed disposer can retain its own resource, but not the other services.
		expect(fixture.publish()).toEqual([name]);
		expect(report).toHaveBeenCalledWith(
			"[main-window services] cleanup failed",
			failure,
		);
		stop();
		expect(fixture.stopped).toHaveLength(serviceNames.length);
	},
);

test("keeps the installation error when rollback also fails and reports every cleanup error", () => {
	const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
	const fixture = lifecycleFixture("registry");
	const attentionFailure = new Error("attention cleanup failed");
	const metadataFailure = new Error("metadata cleanup failed");
	fixture.stopFailures.set("attention", attentionFailure);
	fixture.stopFailures.set("provider-conversation-metadata", metadataFailure);
	expect(() => startMainWindowGlobalServices(fixture.services)).toThrow(
		fixture.startFailure,
	);
	expect(fixture.publish()).toEqual([
		"attention",
		"provider-conversation-metadata",
	]);
	expect(report).toHaveBeenCalledWith(
		"[main-window services] cleanup failed",
		attentionFailure,
	);
	expect(report).toHaveBeenCalledWith(
		"[main-window services] cleanup failed",
		metadataFailure,
	);
});

test("a retired generation cannot run its cleanup again after a replacement starts", () => {
	const fixture = lifecycleFixture();
	const stopPrevious = startMainWindowGlobalServices(fixture.services);
	stopPrevious();
	expect(fixture.publish()).toEqual([]);
	const stopCurrent = startMainWindowGlobalServices(fixture.services);
	stopPrevious();
	expect(fixture.publish()).toEqual(serviceNames);
	expect(fixture.stopped).toHaveLength(serviceNames.length);
	stopCurrent();
	expect(fixture.publish()).toEqual([]);
	expect(fixture.stopped).toHaveLength(serviceNames.length * 2);
});

test("starts and retires main-window services as one lifecycle unit", () => {
	const calls: string[] = [];
	const start = (name: string) =>
		vi.fn(() => {
			calls.push(`start:${name}`);
			return () => calls.push(`stop:${name}`);
		});
	const reconcileProjects = vi.fn(async () => {
		calls.push("start:project-reconciliation");
	});
	const reconcileCanonicalStops = vi.fn(async () => {
		calls.push("start:canonical-stop-reconciliation");
	});
	const requestRuntimeProjection = vi.fn();
	const installRuntimeProjectionReconciler = vi.fn(() => {
		calls.push("start:runtime-projection");
		return {
			request: requestRuntimeProjection,
			stop: () => calls.push("stop:runtime-projection"),
		};
	});
	const installManagedAgentSemanticObserver = vi.fn(() => {
		calls.push("start:managed-agent-semantic");
		return () => calls.push("stop:managed-agent-semantic");
	});

	const stop = startMainWindowGlobalServices({
		installAttentionNotifier: start("attention"),
		installRuntimeProjectionReconciler,
		installManagedAgentSemanticObserver,
		installProviderConversationMetadata: start("provider-conversation-metadata"),
		installNotificationActivation: start("notification-activation"),
		installDiscoveryStateGc: start("discovery-state-gc"),
		reconcileCanonicalStops,
		reconcileProjects,
		startRegistry: start("registry"),
	});

	expect(calls).toEqual([
		"start:attention",
		"start:runtime-projection",
		"start:managed-agent-semantic",
		"start:provider-conversation-metadata",
		"start:notification-activation",
		"start:discovery-state-gc",
		"start:project-reconciliation",
		"start:registry",
		"start:canonical-stop-reconciliation",
	]);
	expect(reconcileProjects).toHaveBeenCalledOnce();
	expect(reconcileCanonicalStops).toHaveBeenCalledOnce();
	expect(installManagedAgentSemanticObserver).toHaveBeenCalledWith(
		requestRuntimeProjection,
	);

	stop();
	expect(calls.slice(9)).toEqual([
		"stop:registry",
		"stop:discovery-state-gc",
		"stop:notification-activation",
		"stop:provider-conversation-metadata",
		"stop:managed-agent-semantic",
		"stop:runtime-projection",
		"stop:attention",
	]);
});
