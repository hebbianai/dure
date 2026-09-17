// AccountsPage's designated store-wiring point (cluster wiring hook). Every
// global-store subscription the provider-accounts page needs lives here; the
// component consumes the returned values and keeps rendering only. Each
// selector stays its own useStore subscription so rerender semantics match
// the previous inline wiring exactly.
import { useCallback } from "react";
import { useStore } from "@/store";

export function useAccountsPageState() {
  const accounts = useStore((s) => s.accounts);
  const activeAccounts = useStore((s) => s.activeAccounts);
  const addAccount = useStore((s) => s.addAccount);
  const renameAccount = useStore((s) => s.renameAccount);
  const removeAccount = useStore((s) => s.removeAccount);
  const setActiveAccount = useStore((s) => s.setActiveAccount);
  const activeSpaceId = useStore((s) => s.activeSpaceId);
  // Stable accessor for click-time handlers: reads the latest accounts
  // snapshot without adding a subscription (login pane open resolves the
  // account at the moment of the click, not at render time).
  const findAccountById = useCallback(
    (accountId: string) =>
      useStore.getState().accounts.find((a) => a.id === accountId),
    [],
  );
  return {
    accounts,
    activeAccounts,
    addAccount,
    renameAccount,
    removeAccount,
    setActiveAccount,
    activeSpaceId,
    findAccountById,
  };
}
