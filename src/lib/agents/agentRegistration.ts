import { useStore } from "@/store";
import { createAgentRegistrationActions } from "./agentRegistryStoreSlice";
import { registerAgentDurably } from "./durableAgentRegistration";

/** Registration coordinates the store and its durable projection; store
 * construction must not depend on the operation that rehydrates it. */
export const { addAgent, adoptAgent } = createAgentRegistrationActions(
	useStore.setState,
	useStore.getState,
	registerAgentDurably,
);
