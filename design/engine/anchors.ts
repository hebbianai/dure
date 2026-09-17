// Surface-detection anchors: one declarative table over a closed rule-type
// vocabulary. A new anchor instance is a data row; a
// new rule TYPE is a code change. The fail-closed rule (unclassified files still
// enter the denominator) lives in the scanner, never here.

export type AnchorRuleType = "import-of" | "registry-file" | "path-cluster";

export interface SurfaceAnchor {
  anchorId: string;
  ruleType: AnchorRuleType;
  params: Record<string, string>;
  surfaceKind: string;
}

export const SURFACE_ANCHORS: readonly SurfaceAnchor[] = [
  {
    anchorId: "dialog-primitive",
    ruleType: "import-of",
    params: { module: "@/components/ui/dialog" },
    surfaceKind: "dialog",
  },
  {
    anchorId: "radix-direct",
    ruleType: "import-of",
    params: { modulePrefix: "radix-ui" },
    surfaceKind: "dialog",
  },
  {
    anchorId: "workspace-panel-registry",
    ruleType: "registry-file",
    params: { file: "src/components/workspace/Workspace.tsx" },
    surfaceKind: "pane",
  },
  {
    anchorId: "workspace-lazy-panel-registry",
    ruleType: "registry-file",
    params: { file: "src/components/workspace/LazyWorkspacePanels.tsx" },
    surfaceKind: "pane",
  },
  {
    // Settings pages are registered by SettingsDialog.tsx's static imports —
    // settingsNav.ts is a data file (icons + ids only) and would be dead here.
    anchorId: "settings-page-registry",
    ruleType: "registry-file",
    params: { file: "src/components/settings/SettingsDialog.tsx" },
    surfaceKind: "settings-page",
  },
  {
    anchorId: "domain-cluster",
    ruleType: "path-cluster",
    params: { root: "src/components" },
    surfaceKind: "component",
  },
];
