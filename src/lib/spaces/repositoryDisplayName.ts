import { pathBasename } from "@/lib/files/paths";

const MAX_REPOSITORY_NAME_LENGTH = 255;

/**
 * Extract the repository segment from the common Git remote URL forms.
 * Remote configuration is untrusted text, so malformed or multiline values
 * fall back instead of entering persistent presentation state.
 */
export function repositoryNameFromRemote(remote: string): string | undefined {
	const value = remote.trim();
	if (!value || /[\0\r\n]/.test(value)) return undefined;

	const withoutQuery = value.replace(/[?#].*$/, "").replace(/[\\/]+$/, "");
	const separator = Math.max(
		withoutQuery.lastIndexOf("/"),
		withoutQuery.lastIndexOf("\\"),
		withoutQuery.lastIndexOf(":"),
	);
	const name = withoutQuery
		.slice(separator + 1)
		.replace(/\.git$/i, "")
		.trim();
	if (
		!name ||
		name === "." ||
		name === ".." ||
		name.length > MAX_REPOSITORY_NAME_LENGTH
	) {
		return undefined;
	}
	return name;
}

/** Git's origin name when usable; the checkout folder remains the fallback. */
export function repositoryDisplayName(path: string, remote?: string): string {
	return (
		(remote ? repositoryNameFromRemote(remote) : undefined) ??
		pathBasename(path)
	);
}
