#!/bin/sh
set -eu

# QA apps, setup and clients own a temporary HOME and must not inherit live
# backend routing, session identity or provider roots. The runner supplies the
# owned roots and pinned DURE_HMUX_BIN/DURE_HMUX_RUNTIME_BIN pair explicitly.
# Backend/relay build overrides have already been installed in the owned CLI
# bundle. Children resolve that bundle instead of bypassing it at runtime.
# This is an environment ingress boundary, not an OS sandbox.
# The runner may provide a unique channel;
# stable remains the compatibility default for older standalone callers.
qa_app_channel=${DURE_QA_APP_CHANNEL:-stable}
exec env \
  -u HEBBIAN_APP_CHANNEL \
  -u VITE_HEBBIAN_APP_CHANNEL \
  -u HEBBIAN_DEV_HOST \
  -u DURE_DEV_PORT \
  -u HEBBIAN_DEV_PORT \
  -u HEBBIAN_SESSION \
  -u HEBBIAN_AGENT \
  -u HEBBIAN_CWD \
  -u BEADS_ACTOR \
  -u DURE_CONTROL_PLANE_BIN \
  -u DURE_CLAUDE_PROCESS_RELAY_BIN \
  -u DURE_BACKEND_PROFILE \
  -u DURE_BACKEND_IDENTITY_FILE \
  -u DURE_BACKEND_KNOWN_HOSTS_FILE \
  -u DURE_BACKEND_SSH_REFERENCE_PROFILE \
  -u DURE_ORCHESTRATION_ENDPOINT \
  -u DURE_ORCHESTRATION_AUTHORIZATION \
  -u DURE_ORCHESTRATION_PARTICIPANT \
  -u DURE_ORCHESTRATION_ENDPOINT_REF \
  -u DURE_ORCHESTRATION_SESSION_IDENTITY \
  -u DURE_ORCHESTRATION_GENERATION \
  -u DURE_ORCHESTRATION_CHECKPOINT \
  -u HMUX \
  -u HMUX_SESSION_ID \
  -u HMUX_SESSION_NAME \
  -u HMUX_WORKSPACE_ID \
  -u HMUX_RUNNER_PRINCIPAL \
  -u HMUX_RUNNER_INSTANCE \
  -u HMUX_CHANNEL_EPOCH \
  -u HMUX_HOST_INSTANCE_ID \
  -u HMUX_TERMINAL_EPOCH \
  -u CODEX_SESSION_ID \
  -u CODEX_THREAD_ID \
  -u CLAUDECODE \
  -u CLAUDE_CODE_ENTRYPOINT \
  -u CLAUDE_AGENT_SDK_VERSION \
  -u CODEX_HOME \
  -u CODEX_SQLITE_HOME \
  -u CLAUDE_CONFIG_DIR \
  -u KIMI_CODE_HOME \
  -u HEBBIAN_HMUX_BIN \
  -u HEBBIAN_HMUX_RUNTIME \
  -u HMUX_RUNTIME \
  -u HEBBIAN_IDE_WINDOW \
  -u HEBBIAN_IDE_PANEL \
  DURE_APP_CHANNEL="$qa_app_channel" \
  VITE_DURE_APP_CHANNEL="$qa_app_channel" \
  "$@"
