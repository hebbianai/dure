interface PluginContainerIdentity {
	plugin: { manifest: { id: string } };
	contributionId: string;
	container: { id: string };
}

export interface PluginSidebarSelection {
	containerKey: string;
	viewId: string | null;
}

export function pluginSidebarContainerKey(
	contribution: PluginContainerIdentity,
): string {
	return JSON.stringify([
		contribution.plugin.manifest.id,
		contribution.contributionId,
		contribution.container.id,
	]);
}

export function selectPluginSidebarContainer<T extends PluginContainerIdentity>(
	containers: readonly T[],
	selectedKey: string | null,
): T | undefined {
	return containers.find(
		(contribution) => pluginSidebarContainerKey(contribution) === selectedKey,
	);
}
