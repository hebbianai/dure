import { useState } from "react";
import { useAvailableProviders } from "@/lib/agents/agentInstalls";
import {
	synchronizeProviderLaunchDefaults,
	updateProviderLaunchPermissionDefault,
} from "@/lib/settings/providerLaunchDefaults";
import { useStore } from "@/store";
import type { Provider } from "@/types";

export function useAgentLaunchPreferences() {
	const availableProviders = useAvailableProviders();
	const defaultProvider = useStore((state) => state.uiPrefs.defaultProvider);
	const setUi = useStore((state) => state.setUiPrefs);
	const skipPermissions = useStore((state) => state.skipPermissions);
	const permissionsReady = useStore(
		(state) => state.providerLaunchDefaults !== null,
	);
	const providerDefaultsError = useStore(
		(state) => state.providerLaunchDefaultsError,
	);
	const [updating, setUpdating] = useState(false);
	const runUpdate = (request: Promise<void>) => {
		setUpdating(true);
		void request.catch(() => {}).finally(() => setUpdating(false));
	};
	return {
		availableProviders,
		defaultProvider,
		skipPermissions,
		permissionsReady,
		providerDefaultsError,
		updating,
		setDefaultProvider: (value: "auto" | Provider) =>
			setUi({ defaultProvider: value === "auto" ? undefined : value }),
		retryPermissions: () => runUpdate(synchronizeProviderLaunchDefaults()),
		updatePermissions: (provider: Provider, value: boolean) =>
			runUpdate(updateProviderLaunchPermissionDefault(provider, value)),
	};
}
