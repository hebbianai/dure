import { createBroadcast } from "@/lib/state/broadcast";

export type DockviewRegistrationListener = (desktopId: string) => void;

const registrations = createBroadcast<string>();

export function publishDockviewRegistration(desktopId: string) {
	registrations.publish(desktopId);
}

export function subscribeDockviewRegistration(
	listener: DockviewRegistrationListener,
): () => void {
	return registrations.subscribe(listener);
}
