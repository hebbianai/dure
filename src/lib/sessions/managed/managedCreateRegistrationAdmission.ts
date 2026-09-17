import { ManagedCreateRetrySameError } from "@/lib/hmux/managed/managedCreateResolution";
import type { Agent } from "@/types";

export type ManagedCreateRegistrationAdmission<T> =
	| { state: "admitted"; agent: Agent; value: T }
	| {
			state: "retained";
			agent: Agent;
			error: unknown;
	  }
	| { state: "rejected"; agent: Agent; error: unknown };

/** Admit one staged registration while preserving unknown outcomes for retry. */
export async function admitManagedCreateRegistration<T>(
	initial: Agent,
	admit: (agent: Agent) => Promise<T>,
): Promise<ManagedCreateRegistrationAdmission<T>> {
	try {
		return { state: "admitted", agent: initial, value: await admit(initial) };
	} catch (error) {
		return error instanceof ManagedCreateRetrySameError
			? {
					state: "retained",
					agent: initial,
					error,
				}
			: { state: "rejected", agent: initial, error };
	}
}
