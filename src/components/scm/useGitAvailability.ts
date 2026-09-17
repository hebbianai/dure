import { useCallback, useEffect, useMemo, useState } from "react";
import { t } from "@/lib/i18n";
import { gitAvailability, type GitAvailability } from "@/lib/ipc/git";
import { useStore } from "@/store";

export type GitAvailabilityState = GitAvailability | { status: "checking" };

/** View-scoped observation: no polling, persisted capability, or launch authority. */
export function useGitAvailability(hostId: string | null, enabled = true) {
	const host = useStore((state) =>
		hostId === null
			? null
			: state.sshHosts.find((candidate) => candidate.id === hostId),
	);
	const [request, setRequest] = useState(0);
	const check = useMemo(
		() => ({ host, enabled, request }),
		[host, enabled, request],
	);
	const [observation, setObservation] = useState<{
		check: typeof check;
		value: GitAvailability;
	} | null>(null);
	const recheck = useCallback(() => setRequest((value) => value + 1), []);
	useEffect(() => {
		if (!check.enabled || check.host === undefined) return;
		let disposed = false;
		void gitAvailability(check.host)
			.catch(
				(error): GitAvailability => ({
					status: "unknown",
					detail: String(error),
				}),
			)
			.then((value) => {
				if (!disposed) setObservation({ check, value });
			});
		return () => {
			disposed = true;
		};
	}, [check]);

	const state: GitAvailabilityState =
		host === undefined
			? { status: "unknown", detail: t("common.sshHostNotFound") }
			: enabled && observation?.check === check
				? observation.value
				: { status: "checking" };
	return { state, recheck, hostName: host?.name };
}
