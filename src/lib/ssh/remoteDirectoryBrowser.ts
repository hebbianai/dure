/** Normalize Windows drive syntax while preserving literal POSIX backslashes. */
export function remoteDirectoryPath(value: string): string {
	const path = value.replace(/^\/(?=[A-Za-z]:(?:[/\\]|$))/, "");
	if (/^[A-Za-z]:(?:[/\\]|$)/.test(path)) {
		const normalized = path.replace(/\\/g, "/");
		return normalized.length === 2 ? `${normalized}/` : normalized;
	}
	return value;
}

export function remoteDirectoryInput(path: string): string {
	return path.endsWith("/") ? path : `${path}/`;
}

export function remoteDirectoryParent(path: string): string {
	const normalized = remoteDirectoryPath(path).replace(/\/$/, "");
	if (/^[A-Za-z]:$/.test(normalized)) return `${normalized}/`;
	const parent = normalized.slice(0, normalized.lastIndexOf("/"));
	return /^[A-Za-z]:$/.test(parent) ? `${parent}/` : parent || "/";
}

export function remoteDirectoryQuery(input: string, current: string) {
	const normalized = remoteDirectoryPath(input);
	const slash = normalized.lastIndexOf("/");
	if (normalized === "~") return { directory: "~", fragment: "" };
	return {
		directory:
			slash < 0
				? current
				: remoteDirectoryPath(normalized.slice(0, slash) || "/"),
		fragment: slash < 0 ? normalized : normalized.slice(slash + 1),
	};
}
