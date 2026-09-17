import type { StateCreator, StoreMutatorIdentifier } from "zustand";

interface SpaceIdentity {
	id: string;
	name: string;
	kind?: "popout";
	originSpaceId?: string;
	returnLayout?: unknown;
}

interface DesktopIdentity extends SpaceIdentity {
	originDesktopId?: string;
}

export interface SpaceDesktopCompatibilityState<Space extends SpaceIdentity> {
	spaces: Space[];
	activeSpaceId: string;
	spaceVisits: Record<string, number>;
	desktops: Space[];
	activeDesktopId: string;
	desktopVisits: Record<string, number>;
}

function owns(value: object, key: PropertyKey): boolean {
	return Object.getOwnPropertyDescriptor(value, key) !== undefined;
}

function canonicalSpace<Space extends SpaceIdentity>(desktop: DesktopIdentity): Space {
	const { originDesktopId, ...identity } = desktop;
	return {
		...identity,
		...(identity.originSpaceId || !originDesktopId
			? {}
			: { originSpaceId: originDesktopId }),
	} as Space;
}

/**
 * Projects deprecated Desktop names onto canonical Space state. Both names
 * share exact references; legacy writes are normalized before mutation.
 */
export function projectDesktopCompatibilityUpdate<
	Space extends SpaceIdentity,
	State extends SpaceDesktopCompatibilityState<Space>,
>(current: State, update: State | Partial<State>): State | Partial<State> {
	if (update === current) return current;
	const candidate = { ...update } as Partial<State>;
	const spaces = owns(candidate, "spaces")
		? candidate.spaces
		: owns(candidate, "desktops")
			? candidate.desktops?.map((desktop) =>
					canonicalSpace<Space>(desktop as DesktopIdentity),
				)
			: current.spaces;
	const activeSpaceId = owns(candidate, "activeSpaceId")
		? candidate.activeSpaceId
		: owns(candidate, "activeDesktopId")
			? candidate.activeDesktopId
			: current.activeSpaceId;
	const spaceVisits = owns(candidate, "spaceVisits")
		? candidate.spaceVisits
		: owns(candidate, "desktopVisits")
			? candidate.desktopVisits
			: current.spaceVisits;

	if (!spaces || !activeSpaceId || !spaceVisits) return candidate;
	return {
		...candidate,
		spaces,
		desktops: spaces,
		activeSpaceId,
		activeDesktopId: activeSpaceId,
		spaceVisits,
		desktopVisits: spaceVisits,
	};
}

/** Wraps internal, hydration, and public setState mutations. */
export function withDesktopStateCompatibility<
	Space extends SpaceIdentity,
	State extends SpaceDesktopCompatibilityState<Space>,
	Mutators extends [StoreMutatorIdentifier, unknown][] = [],
>(creator: StateCreator<State, [], Mutators>): StateCreator<State, [], Mutators> {
	return (set, get, api) => {
		const project = (
			update: State | Partial<State> | ((state: State) => State | Partial<State>),
			replace?: boolean,
		) =>
			set(
				(state) =>
					projectDesktopCompatibilityUpdate(
						state,
						typeof update === "function" ? update(state) : update,
					),
				replace as false,
			);

		api.setState = project as typeof api.setState;
		return projectDesktopCompatibilityUpdate(
			{} as State,
			creator(project as typeof set, get, api),
		) as State;
	};
}
