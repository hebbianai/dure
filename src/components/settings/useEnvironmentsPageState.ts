import { useStore } from "@/store";

/** Keep the settings page's presentation target in the client store. */
export function useEnvironmentsPageState() {
	return { desktopId: useStore((state) => state.activeDesktopId) };
}
