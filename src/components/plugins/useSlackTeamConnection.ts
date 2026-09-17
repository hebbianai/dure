import { useEffect, useState } from "react";
import { useInterfaceMode } from "@/components/workspace/useInterfaceMode";
import {
	type DureBackendProfileSummary,
	listDureBackendProfiles,
} from "@/lib/ipc/dureBackendProfiles";
import { slackConnectionError } from "@/lib/plugins/slackConnection";
import { useStore } from "@/store";

export function useSlackTeamConnection() {
	const pro = useInterfaceMode() === "pro";
	const selected = useStore((state) => state.uiPrefs.slackTeamProfileId);
	const setUiPrefs = useStore((state) => state.setUiPrefs);
	const [profiles, setProfiles] = useState<DureBackendProfileSummary[]>([]);
	const [error, setError] = useState<string>();
	const [loading, setLoading] = useState(true);
	const [revision, setRevision] = useState(0);
	useEffect(() => {
		if (!pro) return;
		let current = true;
		setLoading(true);
		setError(undefined);
		void listDureBackendProfiles()
			.then((next) => {
				if (current) setProfiles(next);
			})
			.catch((reason) => {
				if (current) setError(slackConnectionError(reason));
			})
			.finally(() => {
				if (current) setLoading(false);
			});
		return () => {
			current = false;
		};
	}, [pro, revision]);
	return {
		pro,
		profiles,
		error,
		loading,
		selected: selected ?? profiles.find((entry) => entry.default)?.id,
		select: (id: string) => setUiPrefs({ slackTeamProfileId: id }),
		refresh: () => setRevision((value) => value + 1),
	};
}
