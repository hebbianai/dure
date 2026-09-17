/**
 * The localStorage key of the durable app store. It lives outside store.ts so
 * a script that runs before the app bundle — the boot splash reading the saved
 * theme — can name the same key without pulling the store into its graph.
 */
export const DURABLE_APP_STORE_NAME = "agent-ide";
export const PERSIST_VERSION = 10;
