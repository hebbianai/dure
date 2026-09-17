import { createBroadcast } from "@/lib/state/broadcast";

export type PersistencePhase = "idle" | "saving" | "saved" | "error";

export interface PersistenceStatus {
  phase: PersistencePhase;
  at: number;
  message?: string;
}

type Listener = (status: PersistenceStatus) => void;

let current: PersistenceStatus = { phase: "idle", at: Date.now() };
const changes = createBroadcast<PersistenceStatus>();

export function reportPersistenceStatus(
  phase: PersistencePhase,
  message?: string,
): void {
  current = { phase, message, at: Date.now() };
  changes.publish(current);
}

export function persistenceStatus(): PersistenceStatus {
  return current;
}

export function subscribePersistenceStatus(listener: Listener): () => void {
  const unsubscribe = changes.subscribe(listener);
  listener(current);
  return unsubscribe;
}
