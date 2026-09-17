interface WorktreeReleaseProfile {
	sourceChannel: string;
	targetChannel: string;
	identifier: string;
	dataStoreIdentifier: number[];
}

export function worktreeReleaseProfile(): WorktreeReleaseProfile | undefined {
	const raw = import.meta.env.VITE_DURE_WORKTREE_RELEASE_PROFILE;
	if (!raw) return undefined;
	const profile = JSON.parse(raw) as WorktreeReleaseProfile;
	if (
		!/^dev-[a-z0-9-]{1,60}$/.test(profile.sourceChannel) ||
		profile.targetChannel !== `release-${profile.sourceChannel.slice(4)}` ||
		!/^io\.hebbian\.ade\.release\.[a-f0-9]{10}$/.test(profile.identifier) ||
		!profile.sourceChannel.endsWith(`-${profile.identifier.slice(-10)}`) ||
		!Array.isArray(profile.dataStoreIdentifier) ||
		profile.dataStoreIdentifier.length !== 16 ||
		profile.dataStoreIdentifier.some(
			(byte) => !Number.isInteger(byte) || byte < 0 || byte > 255,
		)
	)
		throw new Error("worktree_release_profile_invalid");
	return profile;
}
