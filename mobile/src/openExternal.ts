/**
 * Links the app hands to the system browser.
 *
 * One path out for every http(s) link — the help site, the feedback form and
 * the hyperlinks a terminal prints — because `window.open` is not one on a
 * phone: wry implements the new-window hook only on macOS, so on iOS and
 * Android the call is a silent no-op. The opener plugin is scoped by
 * `src-tauri/capabilities/external-links.json`; `openExternal.test.ts` reads
 * that file to prove the two addresses below stay inside it.
 */

/**
 * Use the canonical public destination maintained in docs/public/README.md.
 * The trailing slash has no capability weight in the `https://*` opener scope.
 */
export const HELP_URL = "https://dureai.dev/";

/**
 * The public releases repo has issues enabled; the source repo is private and
 * no support address exists anywhere in the repo.
 */
export const FEEDBACK_ISSUES_URL = "https://github.com/hebbianai/hebbian-releases/issues/new";

/**
 * The issue form, prefilled with what a maintainer asks for first. Nothing
 * from the stores — device id, hub fingerprint, host labels — goes in.
 */
export function feedbackUrl(input: { version: string; userAgent: string }): string {
  const params = new URLSearchParams({
    title: "[mobile] ",
    body: `Dure Mobile ${input.version}\n${input.userAgent}\n\n`,
  });
  return `${FEEDBACK_ISSUES_URL}?${params}`;
}

/**
 * Loaded on demand for the same reason as the camera bridge in app.ts: the
 * plugin's JS is mobile-only, and a desktop build or a jsdom test must not
 * evaluate it just because a screen that could open a link was rendered.
 */
async function pluginOpen(url: string): Promise<void> {
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

/**
 * Opens `url` in the system browser. Resolves `null` when it opened and the
 * failure text otherwise — the plugin rejects with a plain string, and a
 * scope miss reads "Not allowed to open url …". Callers show it; nothing here
 * swallows it.
 */
export async function openExternal(
  url: string,
  open: (url: string) => Promise<void> = pluginOpen,
): Promise<string | null> {
  try {
    await open(url);
    return null;
  } catch (error) {
    return String(error);
  }
}
