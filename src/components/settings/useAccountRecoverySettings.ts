import { useEffect, useMemo, useState } from "react";
import type { RecoveryAccount } from "@/lib/agents/accountRecoveryContract";
import { providerAccountDirectoryName } from "@/lib/agents/providers";
import {
	createAccountRecoveryClient,
	type RecoverySettingsSnapshot,
} from "@/lib/ipc/dureAccountRecovery";
import {
	type DureBackendProfileSummary,
	listDureBackendProfiles,
} from "@/lib/ipc/dureBackendProfiles";
import { registerDureProviderCredentialProfile } from "@/lib/ipc/dureProviderCredentialProfile";
import { useStore } from "@/store";
import type { Provider } from "@/types";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";

export function useAccountRecoverySettings(
	authority?: DureBackendRouteAuthorityV1,
) {
	const accounts = useStore((state) => state.accounts);
	const [profiles, setProfiles] = useState<DureBackendProfileSummary[]>([]);
	const [backendId, setBackendId] = useState<string | undefined>(
		authority?.profileId,
	);
	const [provider, setProvider] = useState<Provider>("codex");
	const [observed, setSnapshot] = useState<RecoverySettingsSnapshot>();
	const [enabled, setEnabled] = useState(false);
	const [selected, setSelected] = useState<string[]>([]);
	const [error, setError] = useState<string>();
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [revision, setRevision] = useState(0);
	const snapshot =
		observed?.providerId === provider &&
		observed.routeAuthority.profileId === backendId
			? observed
			: undefined;
	const client = useMemo(
		() => (backendId ? createAccountRecoveryClient(backendId) : undefined),
		[backendId],
	);
	useEffect(() => {
		if (authority) return;
		let current = true;
		void listDureBackendProfiles()
			.then((next) => {
				if (!current) return;
				setProfiles(next);
				setBackendId((id) => id ?? next.find((profile) => profile.default)?.id);
			})
			.catch((reason: unknown) => {
				if (current) setError(String(reason));
			});
		return () => {
			current = false;
		};
	}, [authority]);
	useEffect(() => {
		setSnapshot(undefined);
		if (!client) return;
		let current = true;
		setLoading(true);
		setError(undefined);
		void client
			.get(provider, authority)
			.then((next) => {
				if (!current) return;
				setSnapshot(next);
				setEnabled(next.policy?.enabled ?? false);
				setSelected(
					next.policy?.accounts.map((account) => account.profile.referenceId) ??
						[],
				);
			})
			.catch((reason: unknown) => {
				if (current) setError(String(reason));
			})
			.finally(() => {
				if (current) setLoading(false);
			});
		return () => {
			current = false;
		};
	}, [client, provider, revision, authority]);
	const local = authority
		? authority.target.source === "local"
		: profiles.find((profile) => profile.id === backendId)?.kind === "local";
	const options = new Map<string, string>();
	for (const profile of snapshot?.profiles ?? [])
		options.set(profile.referenceId, profile.referenceId);
	for (const account of snapshot?.policy?.accounts ?? [])
		options.set(account.profile.referenceId, account.name);
	if (local)
		for (const account of accounts)
			if (account.provider === provider) options.set(account.id, account.name);
	async function save() {
		if (!client || !snapshot) return;
		setSaving(true);
		setError(undefined);
		try {
			const permitted: RecoveryAccount[] = [];
			for (const referenceId of selected) {
				let profile =
					snapshot.profiles.find(
						(entry) => entry.referenceId === referenceId,
					) ??
					snapshot.policy?.accounts.find(
						(entry) => entry.profile.referenceId === referenceId,
					)?.profile;
				const account = local
					? accounts.find(
							(entry) =>
								entry.provider === provider && entry.id === referenceId,
						)
					: undefined;
				if (!profile && account) {
					// Registration is an explicit local offer; remote selection never copies credentials.
					const registered = await registerDureProviderCredentialProfile(
						{
							providerId: provider,
							referenceId,
							profileDirectoryName: providerAccountDirectoryName(account),
						},
						{ profileId: backendId, routeAuthority: snapshot.routeAuthority },
					);
					profile = {
						schemaVersion: 1,
						providerId: provider,
						referenceId,
						credentialGeneration: registered.credential_generation!,
					};
				}
				if (!profile)
					throw new Error("provider_credential_profile_unavailable");
				permitted.push({
					profile,
					name: options.get(referenceId) ?? referenceId,
				});
			}
			const policy = await client.put(
				{
					providerId: provider,
					expectedRevision: snapshot.policy?.revision ?? 0,
					idempotencyKey: `recovery-${crypto.randomUUID()}`,
					enabled,
					accounts: permitted,
				},
				snapshot.routeAuthority,
			);
			setSnapshot({
				...snapshot,
				policy,
				profiles: [
					...snapshot.profiles,
					...permitted
						.map((account) => account.profile)
						.filter(
							(profile) =>
								!snapshot.profiles.some(
									(old) => old.referenceId === profile.referenceId,
								),
						),
				],
			});
		} catch (reason) {
			setError(String(reason));
		} finally {
			setSaving(false);
		}
	}
	return {
		profiles,
		backendId,
		setBackendId,
		provider,
		setProvider,
		enabled,
		setEnabled,
		selected,
		setSelected,
		options: [...options].map(([id, name]) => ({ id, name })),
		error,
		loading,
		saving,
		ready: snapshot !== undefined,
		save,
		refresh: () => setRevision((value) => value + 1),
	};
}
