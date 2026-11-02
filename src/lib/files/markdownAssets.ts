// Markdown documents reference images beside them (`![](shots/a.png)`). The
// webview resolves such a reference against its own origin, not the file, so
// the file viewer resolves it here and reads the asset through the same local
// or SSH route as the document.

const WINDOWS_ROOT = /^(?:[a-zA-Z]:[\\/]?|[\\/]{2}[^\\/]+[\\/][^\\/]+[\\/]?|[\\/])/;
const POSIX_ROOT = /^(?:\/+|~(?=\/|$))/;
const URL_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const DRIVE_PATH = /^[a-zA-Z]:[\\/]/;

function isWindowsPath(path: string): boolean {
	return DRIVE_PATH.test(path) || path.startsWith("\\\\") || (path.includes("\\") && !path.includes("/"));
}

function decodeReference(reference: string): string {
	try {
		return decodeURIComponent(reference);
	} catch {
		return reference;
	}
}

/** Collapse `.` and `..` below the path's root without leaving it, except that
 * `~` stays for the remote shell to expand. */
function normalize(path: string, windows: boolean): string {
	const root = path.match(windows ? WINDOWS_ROOT : POSIX_ROOT)?.[0] ?? "";
	const separator = windows ? "\\" : "/";
	const segments: string[] = [];
	for (const segment of path.slice(root.length).split(windows ? /[\\/]/ : "/")) {
		if (!segment || segment === ".") continue;
		if (segment !== "..") segments.push(segment);
		else if (segments.length > 0 && segments[segments.length - 1] !== "..") segments.pop();
		else if (!root || root === "~") segments.push("..");
	}
	const normalizedRoot = root === "~" ? "~/" : windows ? root.replace(/\//g, "\\") : root && "/";
	return normalizedRoot + segments.join(separator);
}

/** The file a Markdown image reference points at, or undefined when the
 * reference is a URL (http:, data:, …), protocol-relative or only a fragment
 * and the webview should keep handling it. */
export function resolveMarkdownAssetPath(documentPath: string, reference: string): string | undefined {
	const trimmed = reference.trim();
	if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) return undefined;
	if (URL_SCHEME.test(trimmed) && !DRIVE_PATH.test(trimmed)) return undefined;
	const target = decodeReference(trimmed.split(/[?#]/)[0] ?? "");
	if (!target) return undefined;
	const windows = isWindowsPath(documentPath) || DRIVE_PATH.test(target);
	const absolute = windows ? WINDOWS_ROOT.test(target) : target.startsWith("/");
	if (absolute) return normalize(target, windows);
	const cut = Math.max(documentPath.lastIndexOf("/"), windows ? documentPath.lastIndexOf("\\") : -1);
	const directory = cut >= 0 ? documentPath.slice(0, cut + 1) : "";
	return normalize(directory + target, windows) || undefined;
}
