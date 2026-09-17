/**
 * Side-effect-free workspace mount hint. Hover intent and background pane
 * presentation can ask WorkspaceDeck to prepare a cold desktop without gaining
 * selection, session, or layout authority. The cache policy remains the sole
 * authority over whether the desktop is admitted.
 */
import { createBroadcast } from "@/lib/state/broadcast";

type PrewarmListener = (desktopId: string) => void;

const requests = createBroadcast<string>();

export function requestDesktopPrewarm(desktopId: string) {
  requests.publish(desktopId);
}

export function onDesktopPrewarmRequest(listener: PrewarmListener) {
  return requests.subscribe(listener);
}
