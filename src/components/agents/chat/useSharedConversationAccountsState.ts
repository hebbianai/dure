import { useStore } from "@/store";

/** Personal account choices for the shared-conversation controls. The account
 * service admits them only for local routes; SSH choices come from the server. */
export function useSharedConversationAccountsState() {
	return useStore((state) => state.accounts);
}
