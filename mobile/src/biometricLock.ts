/**
 * Face ID / fingerprint, for one purpose: proving the person holding the phone
 * is its owner before an approval is answered, and before that gate is armed
 * or disarmed.
 *
 * Same shape as `scanner.ts`: the plugin is behind an injectable bridge, and
 * every outcome is a value rather than an exception, so the screen can tell a
 * dismissed sheet from a missing plugin from a refused face.
 */

/** The plugin surface, injectable so tests and the desktop shell can stand in for it. */
export interface BiometricBridge {
  checkStatus(): Promise<{ isAvailable: boolean; biometryType: number }>;
  authenticate(
    reason: string,
    options?: { allowDeviceCredential?: boolean; cancelTitle?: string; title?: string },
  ): Promise<void>;
}

/** Which sensor the device offers. `unavailable` is also what the desktop shell and jsdom answer. */
export type BiometryKind = "face" | "touch" | "unavailable";

/** What one prompt came back with. */
export type BiometricCheck = "passed" | "cancelled" | "unavailable" | "failed";

/** The plugin's `BiometryType`: 0 none, 1 Touch ID, 2 Face ID, 3 iris. */
const FACE_ID = 2;
const TOUCH_LIKE = new Set([1, 3]);

/**
 * Asks the device which sensor it has. A throw is `unavailable`: the plugin
 * exists only on Android and iOS, and a missing command is the ordinary
 * answer everywhere else.
 */
export async function probeBiometry(bridge: BiometricBridge): Promise<BiometryKind> {
  try {
    const status = await bridge.checkStatus();
    if (!status.isAvailable) return "unavailable";
    if (status.biometryType === FACE_ID) return "face";
    return TOUCH_LIKE.has(status.biometryType) ? "touch" : "unavailable";
  } catch {
    return "unavailable";
  }
}

/**
 * Shows the system sheet and says how it ended.
 *
 * The passcode is allowed as a fallback: after enough failed faces the
 * sensor locks itself out, and without the passcode the gate would hold the
 * owner out of their own approvals until the phone is unlocked some other way.
 */
export async function confirmOwner(
  bridge: BiometricBridge,
  reason: string,
): Promise<BiometricCheck> {
  try {
    await bridge.authenticate(reason, { allowDeviceCredential: true });
    return "passed";
  } catch (error) {
    const text = describe(error);
    if (/cancel/i.test(text)) return "cancelled";
    if (/not found|unavailable|not available/i.test(text)) return "unavailable";
    return "failed";
  }
}

function describe(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    return [record.code, record.message]
      .filter((part) => typeof part === "string")
      .join(" ");
  }
  return String(error);
}
