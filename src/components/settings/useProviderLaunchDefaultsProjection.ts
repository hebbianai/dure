import { useEffect } from "react";
import { installProviderLaunchDefaultsProjection } from "@/lib/settings/providerLaunchDefaults";

export function useProviderLaunchDefaultsProjection() {
	useEffect(() => installProviderLaunchDefaultsProjection(), []);
}
