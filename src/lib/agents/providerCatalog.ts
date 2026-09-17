import {
	PROVIDER_IDS,
	PROVIDERS,
} from "../../../cli/lib/contracts/provider-catalog.mjs";
import type { InterfaceMode } from "@/lib/workspace/pane/interfaceMode";

export { PROVIDERS, PROVIDER_IDS };

/** Rollout visibility is independent of installation and runtime capabilities. */
export function providersForInterfaceMode(mode: InterfaceMode) {
	return PROVIDER_IDS.filter((id) => mode === "pro" || PROVIDERS[id].basic === true);
}
