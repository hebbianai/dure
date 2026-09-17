import type { CommandError } from "./ipc";

export function isCommandError(value: unknown): value is CommandError {
  return typeof value === "object" && value !== null
    && "code" in value && typeof value.code === "string"
    && "message" in value && typeof value.message === "string";
}

export function describeError(error: unknown): string {
  return isCommandError(error) ? `${error.message} (${error.code})` : String(error);
}
