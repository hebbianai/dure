import { useEffect, useState } from "react";
import type { LocalFolderSuggestion } from "@/lib/spaces/localFolderSuggestions";
import { searchLocalProjects } from "@/lib/spaces/localProjectSearch";

export function useLocalProjectSearch(open: boolean, query: string) {
	const search = query.trim();
	const [state, setState] = useState<{
		query: string;
		results: LocalFolderSuggestion[];
		error: boolean;
	} | null>(null);
	useEffect(() => {
		if (!open || !search) return;
		let disposed = false;
		setState(null);
		const timer = setTimeout(() => {
			void searchLocalProjects(search).then(
				(results) => {
					if (!disposed) setState({ query: search, results, error: false });
				},
				() => {
					if (!disposed) setState({ query: search, results: [], error: true });
				},
			);
		}, 200);
		return () => {
			disposed = true;
			clearTimeout(timer);
		};
	}, [open, search]);
	const current = open && search && state?.query === search ? state : null;
	return {
		results: current?.results ?? [],
		loading: Boolean(open && search && !current),
		error: current?.error ?? false,
	};
}
