// Spaces의 보조 "위치 관리" 표면에 보여 줄 등록 위치 선택 로직.
// Project는 저장 모델 이름일 뿐 UI 계층이 아니다. 이 모듈은 검색과 핀 우선
// 정렬만 맡겨 React/Radix 없이 계약을 검증할 수 있게 한다.

export interface ManagedLocationProject {
	readonly id: string;
	readonly name: string;
	readonly path: string;
	readonly kind: "local" | "ssh";
	readonly sshHostId?: string;
	readonly isRepo: boolean;
}

export interface ManagedLocation {
	readonly project: ManagedLocationProject;
	readonly hostName?: string;
	readonly pinned: boolean;
}

export function selectManagedLocations(input: {
	projects: readonly ManagedLocationProject[];
	pinnedProjectIds: readonly string[];
	sshHosts: readonly { readonly id: string; readonly name: string }[];
	query?: string;
}): ManagedLocation[] {
	const pinnedIds = new Set(input.pinnedProjectIds);
	const hostNames = new Map(input.sshHosts.map((host) => [host.id, host.name]));
	const query = input.query?.trim().toLocaleLowerCase() ?? "";

	return input.projects
		.map((project, order) => ({
			project,
			order,
			pinned: pinnedIds.has(project.id),
			hostName:
				project.kind === "ssh" && project.sshHostId
					? (hostNames.get(project.sshHostId) ?? project.sshHostId)
					: undefined,
		}))
		.filter(({ project, hostName }) => {
			if (!query) return true;
			return `${project.name}\n${project.path}\n${hostName ?? ""}`
				.toLocaleLowerCase()
				.includes(query);
		})
		.sort((left, right) => {
			if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
			return left.order - right.order;
		})
		.map(({ order: _order, ...location }) => location);
}
