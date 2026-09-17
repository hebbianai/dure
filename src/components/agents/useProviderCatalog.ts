import { useRef, useState } from "react";
import type { ObservedProviderModelV1 } from "@/lib/agents/providerModels";
import type { ProviderCatalogSource } from "@/lib/agents/providerModelCatalogSource";

/** Discovery is an explicit menu action, never a pane-mount side effect. */
export function useProviderCatalog(source?: ProviderCatalogSource) {
	const [snapshot, setSnapshot] = useState<{
		key: string;
		models?: readonly ObservedProviderModelV1[];
		loading: boolean;
		error: boolean;
	}>();
	const request = useRef(0);
	const inFlight = useRef<{
		key: string;
		promise: Promise<readonly ObservedProviderModelV1[] | undefined>;
	}>(undefined);
	const current = snapshot?.key === source?.key ? snapshot : undefined;
	const refresh = async () => {
		if (!source) return;
		if (inFlight.current?.key === source.key) return inFlight.current.promise;
		const sequence = ++request.current;
		setSnapshot({
			key: source.key,
			models: current?.models,
			loading: true,
			error: false,
		});
		const pending = (async () => {
			try {
				const models = await source.load();
				if (sequence === request.current)
					setSnapshot({ key: source.key, models, loading: false, error: false });
				return models;
			} catch {
				if (sequence === request.current)
					setSnapshot({ key: source.key, loading: false, error: true });
			}
		})();
		inFlight.current = { key: source.key, promise: pending };
		void pending.then(() => {
			if (inFlight.current?.promise === pending) inFlight.current = undefined;
		});
		return pending;
	};
	return {
		refresh,
		models: current?.models,
		loading: current?.loading ?? false,
		error: current?.error ?? false,
		onOpenChange: (open: boolean) => {
			if (open) void refresh();
		},
	};
}
