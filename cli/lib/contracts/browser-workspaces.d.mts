export interface BrowserWorkspace {
  readonly workspace_id: string;
  readonly project_name: string;
  readonly root_path: string;
}

export interface BrowserWorkspacePage {
  readonly workspaces: BrowserWorkspace[];
  readonly next: string | null;
}

export function parseBrowserWorkspacePage(
  value: unknown,
  after?: string,
): BrowserWorkspacePage | null;
