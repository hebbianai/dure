export function parseGitHubAssignableUsers(json: string): string[] | null {
	try {
		const value: unknown = JSON.parse(json);
		if (!Array.isArray(value) || !value.every(Array.isArray)) return null;
		const users: string[] = [];
		for (const page of value) {
			for (const user of page) {
				if (!user || typeof user.login !== "string" || !user.login.trim())
					return null;
				users.push(user.login);
			}
		}
		return [...new Set(users)];
	} catch {
		return null;
	}
}

/** Keep existing assignees removable even when they no longer appear in the candidate list. */
export function githubAssigneeChoices(
	available: readonly string[],
	selected: readonly string[],
	query: string,
) {
	const chosen = new Set(selected.map((login) => login.toLowerCase()));
	const users = new Map(
		[...available, ...selected].map((login) => [login.toLowerCase(), login]),
	);
	const search = query.trim().replace(/^@/, "").toLowerCase();
	return [...users.values()]
		.filter((login) => login.toLowerCase().includes(search))
		.sort((a, b) => a.localeCompare(b))
		.map((login) => ({ login, selected: chosen.has(login.toLowerCase()) }));
}
