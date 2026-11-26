/** Names the Dure Agent a Chat agent's own tool processes run for. The
 * backend's structured runtime sets it for the provider's tool shells, so a
 * `dure run` started there can record that Agent as the new Run's parent. It
 * identifies the calling agent only: anything the CLI starts on its own
 * behalf, such as a local backend, must not inherit it. */
export const CALLER_AGENT_ID_ENVIRONMENT = "DURE_AGENT_ID";
