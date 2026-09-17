import { createValueStore } from "@/lib/state/broadcast";

type Listener = () => void;

const hoveredPane = createValueStore<string | null>(null);

/** Spaces와 Dockview가 공유하는 정확한 presentation identity.
 * JSON tuple은 desktop/pane 문자열 경계가 달라도 충돌하지 않는다. */
export function spacesPaneHoverKey(desktopId: string, paneId: string): string {
  return JSON.stringify([desktopId, paneId]);
}

export function getSpacesPaneHover(): string | null {
  return hoveredPane.get();
}

export function subscribeSpacesPaneHover(listener: Listener): () => void {
  return hoveredPane.subscribe(listener);
}

export function setSpacesPaneHover(target: string): void {
  hoveredPane.set(target);
}

/** target을 주면 그 hover가 여전히 최신일 때만 해제한다. 빠르게 다른 행으로
 * 이동한 뒤 늦게 도착한 pointerleave가 새 강조를 지우지 않게 한다. */
export function clearSpacesPaneHover(target?: string): void {
  if (target !== undefined && hoveredPane.get() !== target) return;
  hoveredPane.set(null);
}
