/** Pre-Dure identifiers accepted only while reading existing local state or
 * an in-flight payload produced by an older app generation. New output must
 * use the canonical identifier owned by the consuming domain. */
export const LEGACY_PRODUCT_COMPATIBILITY = {
	dragPayloadPrefix: "hebbian:",
	panelDragMime: "application/hebbian-panel",
	paneTransferMime: "application/x-hebbian-pane",
	paneWindowDropEvent: "hebbian:pane-window-drop-v1",
	sshConfigHostDragType: "hebbian/ssh-config-host",
	mainDesktopStorageKey: "hebbian-ide:last-main-desktop",
	hmuxStandaloneOptOutStorageKey: "hebbian.hmuxStandaloneOptOut.v1",
	hmuxStandaloneEnvironmentKey: "VITE_HEBBIAN_HMUX_STANDALONE",
	runtimeIdentityPrefix: "hebbian-runtime-v1;",
	setupScriptPath: ".hebbian/setup.sh",
	webviewInstanceKey: "__hebbianHmuxDiagnosticWebviewInstanceV1",
	webviewStartedAtKey: "__hebbianHmuxDiagnosticWebviewStartedAtV1",
	themeStyleElementId: "hebbian-theme-overrides",
	builtinThemeIds: {
		dark: "hebbian-dark",
		light: "hebbian-light",
	},
} as const;
