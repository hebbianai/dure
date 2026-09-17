import { nanoid } from "nanoid";

/** Pane identity outlives its content and runtime target. */
export function createPaneId(): string {
	return `pane-${nanoid()}`;
}
