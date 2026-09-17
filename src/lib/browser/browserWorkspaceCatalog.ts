import type { createDureBrowserClient } from "@/lib/ipc/dureBrowser";

/** Locate a saved or newly created workspace through the backend's catalog. */
export async function browserWorkspaceCatalog(
	client: Pick<ReturnType<typeof createDureBrowserClient>, "workspaces">,
	workspaceId: string | undefined,
	current: () => boolean,
) {
	let catalog = await client.workspaces();
	let rows = catalog.workspaces;
	const cursors = new Set<string>();
	while (
		current() &&
		workspaceId &&
		!rows.some((row) => row.workspace_id === workspaceId) &&
		catalog.next
	) {
		if (cursors.has(catalog.next))
			throw new Error("browser_workspace_cursor_repeated");
		cursors.add(catalog.next);
		catalog = await client.workspaces(catalog.next);
		rows = [...rows, ...catalog.workspaces];
	}
	return { workspaces: rows, next: catalog.next };
}
