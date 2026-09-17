import { installAgentAttentionNotifier } from "@/lib/agents/agentAttentionNotifier";
import {
	type AgentRuntimeProjectionReconciler,
	installAgentRuntimeProjectionReconciliationRuntime,
} from "@/lib/agents/agentRuntimeProjectionReconciliationRuntime";
import { reconcileCanonicalAgentStopsOnceV1 } from "@/lib/agents/canonicalAgentStopRuntime";
import {
	installManagedAgentSemanticObserverRuntime,
	type ManagedAgentRuntimeProjectionRefresh,
} from "@/lib/agents/managedAgentSemanticObserverRuntime";
import { installProviderConversationMetadataRuntime } from "@/lib/agents/providerConversationMetadataRuntime";
import { hmux } from "@/lib/ipc";
import {
	type DiscoveryStateGcReport,
	installDiscoveryStateGcService,
} from "@/lib/maintenance/discoveryStateGcService";
import { startRegistrySync } from "@/lib/persistence/registry";
import { qaLog } from "@/lib/qa/qaLog";
import { installNotificationActivationHandler } from "@/lib/settings/notificationActivation";
import { reconcilePersistedLocalProjects } from "@/lib/spaces/localProjectReconciliation";

interface MainWindowGlobalServices {
	installAttentionNotifier(): () => void;
	installRuntimeProjectionReconciler(): AgentRuntimeProjectionReconciler;
	installManagedAgentSemanticObserver(
		refreshRuntimeProjection: ManagedAgentRuntimeProjectionRefresh,
	): () => void;
	installProviderConversationMetadata(): () => void;
	installNotificationActivation(): () => void;
	installDiscoveryStateGc(): () => void;
	reconcileCanonicalStops(): Promise<unknown>;
	reconcileProjects(): Promise<void>;
	startRegistry(): () => void;
}

const defaultServices: MainWindowGlobalServices = {
	installAttentionNotifier: installAgentAttentionNotifier,
	installRuntimeProjectionReconciler:
		installAgentRuntimeProjectionReconciliationRuntime,
	installManagedAgentSemanticObserver: (refreshRuntimeProjection) =>
		installManagedAgentSemanticObserverRuntime(
			undefined,
			refreshRuntimeProjection,
		),
	installProviderConversationMetadata: installProviderConversationMetadataRuntime,
	installNotificationActivation: installNotificationActivationHandler,
	installDiscoveryStateGc: () =>
		installDiscoveryStateGcService({
			runGc: (mode) => hmux.localStateGc<DiscoveryStateGcReport>(mode),
			log: (event) => qaLog("stateGc", event),
		}),
	reconcileCanonicalStops: reconcileCanonicalAgentStopsOnceV1,
	reconcileProjects: reconcilePersistedLocalProjects,
	startRegistry: startRegistrySync,
};

/** Owns installed subscriptions through startup failure or main-window cleanup. */
export function startMainWindowGlobalServices(
	services: MainWindowGlobalServices = defaultServices,
): () => void {
	const cleanups: Array<() => void> = [];
	const retire = (): unknown[] => {
		const failures: unknown[] = [];
		// Drain the owned handles before invoking potentially reentrant cleanup.
		for (const cleanup of cleanups.splice(0).reverse()) {
			try {
				cleanup();
			} catch (error) {
				failures.push(error);
			}
		}
		for (const error of failures) {
			console.error("[main-window services] cleanup failed", error);
		}
		return failures;
	};
	try {
		cleanups.push(services.installAttentionNotifier());
		const runtimeProjectionReconciler =
			services.installRuntimeProjectionReconciler();
		cleanups.push(() => runtimeProjectionReconciler.stop());
		cleanups.push(
			services.installManagedAgentSemanticObserver(
				runtimeProjectionReconciler.request,
			),
		);
		cleanups.push(services.installProviderConversationMetadata());
		cleanups.push(services.installNotificationActivation());
		cleanups.push(services.installDiscoveryStateGc());
		void services.reconcileProjects();
		cleanups.push(services.startRegistry());
		void services.reconcileCanonicalStops();
	} catch (error) {
		retire();
		throw error;
	}

	return () => {
		const failures = retire();
		if (failures.length > 0) throw failures[0];
	};
}
