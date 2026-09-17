export interface BrowserResourceIdentity {
  readonly resource_id: string;
  readonly generation: string;
  readonly workspace_id: string;
}
export interface BrowserWorkspaceTarget {
  readonly workspace_id: string;
  readonly generation: string;
  readonly revision: string;
  readonly current_resource: BrowserResourceIdentity | null;
}
export function parseBrowserWorkspaceTarget(value: unknown): BrowserWorkspaceTarget | null;
export function parseBrowserWorkspaceCatalogTarget(value: unknown): BrowserWorkspaceTarget | null;
export function browserWorkspaceSelectionResult(expected: BrowserWorkspaceTarget, resource: BrowserResourceIdentity, value: unknown): BrowserWorkspaceTarget | null;
