mod migration;
use migration::migrate_schema;

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use dure_app::{CURRENT_STORE_SCHEMA_VERSION, DomainStoreErrorV1, StoreSchemaInfoV1};
use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteRow, SqliteSynchronous,
};
use sqlx::{Connection, Row, SqliteConnection, SqlitePool};

use crate::error::{io, map_sqlx, storage};
use crate::schedule_schema::*;

const DEFAULT_BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_CONNECTIONS: u32 = 4;
static BACKUP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub(crate) const CREATE_METADATA: &str = r#"
CREATE TABLE IF NOT EXISTS store_metadata (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version INTEGER NOT NULL CHECK (schema_version > 0),
    min_reader_version INTEGER NOT NULL CHECK (min_reader_version > 0),
    min_writer_version INTEGER NOT NULL CHECK (min_writer_version > 0),
    migration_from_version INTEGER,
    migration_to_version INTEGER,
    migration_backup_path TEXT,
    CHECK (
        (
            migration_from_version IS NULL
            AND migration_to_version IS NULL
            AND migration_backup_path IS NULL
        )
        OR
        (
            migration_from_version IS NOT NULL
            AND migration_to_version IS NOT NULL
            AND migration_backup_path IS NOT NULL
        )
    )
)
"#;

const CREATE_PROJECTS: &str = r#"
CREATE TABLE IF NOT EXISTS projects (
    project_id TEXT PRIMARY KEY,
    root_path TEXT NOT NULL,
    display_name TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
)
"#;

const CREATE_WORKSPACES: &str = r#"
CREATE TABLE IF NOT EXISTS workspaces (
    workspace_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
    root_path TEXT NOT NULL,
    base_commit_sha TEXT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
)
"#;

const CREATE_AGENTS: &str = r#"
CREATE TABLE IF NOT EXISTS agents (
    agent_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE RESTRICT,
    provider_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
)
"#;

const CREATE_SESSION_BINDINGS: &str = r#"
CREATE TABLE IF NOT EXISTS session_bindings (
    agent_id TEXT PRIMARY KEY REFERENCES agents(agent_id) ON DELETE CASCADE,
    runtime_kind_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    provider_conversation_id TEXT,
    credential_reference_id TEXT,
    binding_generation INTEGER NOT NULL CHECK (binding_generation > 0),
    bound_at_ms INTEGER NOT NULL
)
"#;

pub(crate) const CREATE_AGENT_INTERACTION_SESSIONS: &str = r#"
CREATE TABLE IF NOT EXISTS agent_interaction_sessions (
    interaction_session_id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    agent_id TEXT NOT NULL UNIQUE REFERENCES agents(agent_id) ON DELETE CASCADE,
    provider_id TEXT NOT NULL,
    execution_profile_json TEXT NOT NULL,
    provider_conversation_ref TEXT,
    runtime_generation TEXT NOT NULL,
    provider_epoch TEXT NOT NULL,
    timeline_epoch TEXT NOT NULL,
    binding_revision INTEGER NOT NULL CHECK (binding_revision > 0),
    history_complete INTEGER NOT NULL CHECK (history_complete IN (0, 1)),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
)
"#;

const CREATE_AGENT_PROVIDER_STREAMS: &str = r#"
CREATE TABLE IF NOT EXISTS agent_provider_streams (
    interaction_session_id TEXT NOT NULL
        REFERENCES agent_interaction_sessions(interaction_session_id) ON DELETE CASCADE,
    runtime_generation TEXT NOT NULL,
    provider_epoch TEXT NOT NULL,
    committed_through_sequence INTEGER NOT NULL CHECK (committed_through_sequence >= 0),
    pending_snapshot_through_sequence INTEGER NOT NULL DEFAULT 0
        CHECK (pending_snapshot_through_sequence >= 0),
    retired_at_ms INTEGER CHECK (retired_at_ms IS NULL OR retired_at_ms >= 0),
    PRIMARY KEY (interaction_session_id, runtime_generation, provider_epoch)
)
"#;

pub(crate) const CREATE_AGENT_TIMELINE_ROWS: &str = r#"
CREATE TABLE IF NOT EXISTS agent_timeline_rows (
    interaction_session_id TEXT NOT NULL
        REFERENCES agent_interaction_sessions(interaction_session_id) ON DELETE CASCADE,
    timeline_epoch TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    item_id TEXT NOT NULL,
    turn_id TEXT,
    client_message_id TEXT,
    provider_message_id TEXT,
    body_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (interaction_session_id, timeline_epoch, sequence),
    UNIQUE (interaction_session_id, item_id)
)
"#;

const CREATE_AGENT_TIMELINE_LIVE_TEXT: &str = r#"
CREATE TABLE IF NOT EXISTS agent_timeline_live_text (
    interaction_session_id TEXT NOT NULL
        REFERENCES agent_interaction_sessions(interaction_session_id) ON DELETE CASCADE,
    stream_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('assistant', 'reasoning', 'tool_input')),
    text_value TEXT NOT NULL,
    turn_id TEXT,
    client_message_id TEXT,
    provider_message_id TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    PRIMARY KEY (interaction_session_id, stream_id),
    UNIQUE (interaction_session_id, item_id)
)
"#;

pub(crate) const CREATE_AGENT_TIMELINE_SOURCE_RECEIPTS: &str = r#"
CREATE TABLE IF NOT EXISTS agent_timeline_source_receipts (
    interaction_session_id TEXT NOT NULL
        REFERENCES agent_interaction_sessions(interaction_session_id) ON DELETE CASCADE,
    runtime_generation TEXT NOT NULL,
    provider_epoch TEXT NOT NULL,
    provider_sequence INTEGER NOT NULL CHECK (provider_sequence > 0),
    event_fingerprint TEXT NOT NULL,
    receipt_json TEXT NOT NULL,
    recorded_at_ms INTEGER NOT NULL CHECK (recorded_at_ms >= 0),
    PRIMARY KEY (
        interaction_session_id,
        runtime_generation,
        provider_epoch,
        provider_sequence
    )
)
"#;

const CREATE_AGENT_PROVIDER_GAPS: &str = r#"
CREATE TABLE IF NOT EXISTS agent_provider_gaps (
    interaction_session_id TEXT NOT NULL
        REFERENCES agent_interaction_sessions(interaction_session_id) ON DELETE CASCADE,
    runtime_generation TEXT NOT NULL,
    provider_epoch TEXT NOT NULL,
    requested_after_sequence INTEGER NOT NULL CHECK (requested_after_sequence >= 0),
    dropped_through_sequence INTEGER NOT NULL
        CHECK (dropped_through_sequence > requested_after_sequence),
    receipt_json TEXT NOT NULL,
    observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms >= 0),
    PRIMARY KEY (
        interaction_session_id,
        runtime_generation,
        provider_epoch,
        requested_after_sequence,
        dropped_through_sequence
    )
)
"#;

pub(crate) const CREATE_AGENT_PENDING_REQUESTS: &str = r#"
CREATE TABLE IF NOT EXISTS agent_pending_requests (
    interaction_session_id TEXT NOT NULL
        REFERENCES agent_interaction_sessions(interaction_session_id) ON DELETE CASCADE,
    request_id TEXT NOT NULL,
    runtime_generation TEXT NOT NULL,
    provider_epoch TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('permission', 'question')),
    turn_id TEXT,
    client_message_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    origin_provider_sequence INTEGER NOT NULL CHECK (origin_provider_sequence >= 0),
    state TEXT NOT NULL CHECK (state IN ('pending', 'resolved', 'canceled', 'stale')),
    outcome_json TEXT,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    PRIMARY KEY (interaction_session_id, request_id)
)
"#;

const CREATE_AGENT_PENDING_REQUESTS_CURRENT_INDEX: &str = r#"
CREATE INDEX IF NOT EXISTS agent_pending_requests_current_idx
ON agent_pending_requests (
    interaction_session_id,
    runtime_generation,
    provider_epoch,
    state,
    created_at_ms,
    request_id
)
"#;

const CREATE_AGENT_TURN_EFFECTS: &str = r#"
CREATE TABLE IF NOT EXISTS agent_turn_effects (
    interaction_session_id TEXT NOT NULL
        REFERENCES agent_interaction_sessions(interaction_session_id) ON DELETE CASCADE,
    client_message_id TEXT NOT NULL,
    runtime_generation TEXT NOT NULL,
    provider_epoch TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    intent_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('prepared', 'accepted', 'failed', 'uncertain')),
    provider_receipt_json TEXT,
    timeline_sequence INTEGER NOT NULL CHECK (timeline_sequence > 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    PRIMARY KEY (interaction_session_id, client_message_id)
)
"#;

const CREATE_AGENT_PENDING_ANSWER_EFFECTS_V23_TO_V27: &str = r#"
CREATE TABLE IF NOT EXISTS agent_pending_answer_effects (
    idempotency_key TEXT PRIMARY KEY,
    interaction_session_id TEXT NOT NULL
        REFERENCES agent_interaction_sessions(interaction_session_id) ON DELETE CASCADE,
    request_id TEXT NOT NULL,
    runtime_generation TEXT NOT NULL,
    provider_epoch TEXT NOT NULL,
    intent_json TEXT NOT NULL,
    request_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('prepared', 'succeeded', 'failed')),
    provider_receipt_json TEXT,
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
)
"#;

const CREATE_AGENT_PENDING_ANSWER_EFFECTS: &str = r#"
CREATE TABLE IF NOT EXISTS agent_pending_answer_effects (
    idempotency_key TEXT PRIMARY KEY,
    interaction_session_id TEXT NOT NULL
        REFERENCES agent_interaction_sessions(interaction_session_id) ON DELETE CASCADE,
    request_id TEXT NOT NULL,
    runtime_generation TEXT NOT NULL,
    provider_epoch TEXT NOT NULL,
    intent_json TEXT NOT NULL,
    request_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('prepared', 'succeeded', 'failed', 'uncertain')),
    provider_receipt_json TEXT,
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
)
"#;

const RENAME_AGENT_PENDING_ANSWER_EFFECTS_V27: &str =
    "ALTER TABLE agent_pending_answer_effects RENAME TO agent_pending_answer_effects_v27";

const COPY_AGENT_PENDING_ANSWER_EFFECTS_V27: &str = r#"
INSERT INTO agent_pending_answer_effects (
    idempotency_key,
    interaction_session_id,
    request_id,
    runtime_generation,
    provider_epoch,
    intent_json,
    request_json,
    state,
    provider_receipt_json,
    updated_at_ms
)
SELECT
    idempotency_key,
    interaction_session_id,
    request_id,
    runtime_generation,
    provider_epoch,
    intent_json,
    request_json,
    state,
    provider_receipt_json,
    updated_at_ms
FROM agent_pending_answer_effects_v27
"#;

const DROP_AGENT_PENDING_ANSWER_EFFECTS_V27: &str = "DROP TABLE agent_pending_answer_effects_v27";

pub(crate) const CREATE_AGENT_RUNTIME_SELECTIONS: &str = r#"
CREATE TABLE IF NOT EXISTS agent_runtime_selections (
    agent_id TEXT PRIMARY KEY REFERENCES agents(agent_id) ON DELETE CASCADE,
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    provider_id TEXT NOT NULL,
    interaction_profile TEXT NOT NULL
        CHECK (interaction_profile IN ('native_cli', 'structured_protocol')),
    revision INTEGER NOT NULL CHECK (revision > 0),
    selected_by_operation_id TEXT UNIQUE,
    selection_json TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    CHECK (
        (revision = 1 AND selected_by_operation_id IS NULL)
        OR (revision > 1 AND selected_by_operation_id IS NOT NULL)
    )
)
"#;

pub(crate) const CREATE_AGENT_RUNTIME_NATIVE_REHOST_RECEIPTS: &str = r#"
CREATE TABLE IF NOT EXISTS agent_runtime_native_rehost_receipts (
    agent_id TEXT PRIMARY KEY REFERENCES agents(agent_id) ON DELETE CASCADE,
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    operation_id TEXT NOT NULL UNIQUE,
    selection_revision INTEGER NOT NULL CHECK (selection_revision > 1),
    source_session_id TEXT NOT NULL,
    source_workspace_id TEXT NOT NULL,
    source_runner_principal TEXT NOT NULL,
    source_runner_instance TEXT NOT NULL,
    source_channel_epoch TEXT NOT NULL,
    source_host_instance_id TEXT NOT NULL,
    source_terminal_epoch TEXT NOT NULL,
    session_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    launch_idempotency_key TEXT NOT NULL,
    provider_launch_reference TEXT,
    committed_at_ms INTEGER NOT NULL CHECK (committed_at_ms >= 0)
)
"#;

pub(crate) const CREATE_AGENT_RUNTIME_TRANSITIONS: &str = r#"
CREATE TABLE IF NOT EXISTS agent_runtime_transitions (
    operation_id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK (
        state IN (
            'admitted',
            'source_retained',
            'source_stopped',
            'repair_required',
            'target_started',
            'committed',
            'superseded'
        )
    ),
    journal_revision INTEGER NOT NULL CHECK (journal_revision > 0),
    record_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    CHECK ((state = 'admitted' AND journal_revision = 1) OR state != 'admitted')
)
"#;

pub(crate) const CREATE_AGENT_RUNTIME_TRANSITIONS_ACTIVE_INDEX: &str = r#"
CREATE UNIQUE INDEX IF NOT EXISTS agent_runtime_transitions_active_idx
ON agent_runtime_transitions (agent_id)
WHERE state NOT IN ('committed', 'source_retained', 'superseded')
"#;

const DROP_AGENT_RUNTIME_TRANSITIONS_ACTIVE_INDEX_V28: &str =
    "DROP INDEX IF EXISTS agent_runtime_transitions_active_idx";

const RENAME_AGENT_RUNTIME_TRANSITIONS_V28: &str =
    "ALTER TABLE agent_runtime_transitions RENAME TO agent_runtime_transitions_v28";

const COPY_AGENT_RUNTIME_TRANSITIONS_V28: &str = r#"
INSERT INTO agent_runtime_transitions (
    operation_id,
    idempotency_key,
    agent_id,
    state,
    journal_revision,
    record_json,
    created_at_ms,
    updated_at_ms
)
SELECT
    operation_id,
    idempotency_key,
    agent_id,
    state,
    journal_revision,
    record_json,
    created_at_ms,
    updated_at_ms
FROM agent_runtime_transitions_v28
"#;

const DROP_AGENT_RUNTIME_TRANSITIONS_V28: &str = "DROP TABLE agent_runtime_transitions_v28";

const DROP_AGENT_RUNTIME_TRANSITIONS_ACTIVE_INDEX_V29: &str =
    "DROP INDEX IF EXISTS agent_runtime_transitions_active_idx";

const RENAME_AGENT_RUNTIME_TRANSITIONS_V29: &str =
    "ALTER TABLE agent_runtime_transitions RENAME TO agent_runtime_transitions_v29";

const COPY_AGENT_RUNTIME_TRANSITIONS_V29: &str = r#"
INSERT INTO agent_runtime_transitions (
    operation_id,
    idempotency_key,
    agent_id,
    state,
    journal_revision,
    record_json,
    created_at_ms,
    updated_at_ms
)
SELECT
    operation_id,
    idempotency_key,
    agent_id,
    state,
    journal_revision,
    record_json,
    created_at_ms,
    updated_at_ms
FROM agent_runtime_transitions_v29
"#;

const DROP_AGENT_RUNTIME_TRANSITIONS_V29: &str = "DROP TABLE agent_runtime_transitions_v29";

pub(crate) const CREATE_AGENT_RUNTIME_CLOSES: &str = r#"
CREATE TABLE IF NOT EXISTS agent_runtime_closes (
    operation_id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK (state IN ('admitted', 'source_retained', 'stopped')),
    journal_revision INTEGER NOT NULL CHECK (journal_revision > 0),
    record_json TEXT NOT NULL,
    removal_json TEXT,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    CHECK (
        (state = 'admitted' AND journal_revision = 1)
        OR (state IN ('source_retained', 'stopped') AND journal_revision = 2)
    )
)
"#;

pub(crate) const CREATE_AGENT_RUNTIME_CLOSES_ACTIVE_INDEX: &str = r#"
CREATE UNIQUE INDEX IF NOT EXISTS agent_runtime_closes_active_idx
ON agent_runtime_closes (
    agent_id,
    CAST(json_extract(record_json, '$.intent.source.revision') AS INTEGER)
)
WHERE state != 'source_retained'
"#;

pub(crate) const CREATE_AGENT_DISPATCH_STOPS_V33: &str = r#"
CREATE TABLE IF NOT EXISTS agent_dispatch_stops (
    operation_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE RESTRICT,
    spawn_operation_id TEXT NOT NULL,
    plan_token TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (
        state IN (
            'planned',
            'authorized',
            'succeeded',
            'source_retained',
            'workspace_replaced'
        )
    ),
    journal_revision INTEGER NOT NULL CHECK (journal_revision > 0),
    runtime_selection_json TEXT NOT NULL,
    runtime_authority_json TEXT NOT NULL,
    owned_checkout_json TEXT NOT NULL,
    runtime_close_operation_id TEXT UNIQUE
        REFERENCES agent_runtime_closes(operation_id) ON DELETE RESTRICT,
    terminal_workspace_receipt_json TEXT,
    planned_at_ms INTEGER NOT NULL CHECK (planned_at_ms >= 0),
    authorized_at_ms INTEGER,
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= planned_at_ms),
    CHECK (
        (
            state = 'planned'
            AND journal_revision = 1
            AND runtime_close_operation_id IS NULL
            AND terminal_workspace_receipt_json IS NULL
            AND authorized_at_ms IS NULL
        )
        OR (
            state = 'authorized'
            AND journal_revision = 2
            AND runtime_close_operation_id IS NOT NULL
            AND terminal_workspace_receipt_json IS NULL
            AND authorized_at_ms IS NOT NULL
        )
        OR (
            state = 'succeeded'
            AND journal_revision = 3
            AND runtime_close_operation_id IS NOT NULL
            AND terminal_workspace_receipt_json IS NOT NULL
            AND authorized_at_ms IS NOT NULL
        )
        OR (
            state IN ('source_retained', 'workspace_replaced')
            AND journal_revision = 3
            AND runtime_close_operation_id IS NOT NULL
            AND terminal_workspace_receipt_json IS NULL
            AND authorized_at_ms IS NOT NULL
        )
    ),
    CHECK (authorized_at_ms IS NULL OR (
        authorized_at_ms >= planned_at_ms AND updated_at_ms >= authorized_at_ms
    ))
)
"#;

pub(crate) const CREATE_AGENT_DISPATCH_STOPS_V34: &str = r#"
CREATE TABLE IF NOT EXISTS agent_dispatch_stops (
    operation_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE RESTRICT,
    spawn_operation_id TEXT NOT NULL,
    plan_token TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (
        state IN (
            'planned',
            'superseded',
            'authorized',
            'succeeded',
            'source_retained',
            'workspace_replaced'
        )
    ),
    journal_revision INTEGER NOT NULL CHECK (journal_revision > 0),
    runtime_selection_json TEXT NOT NULL,
    runtime_authority_json TEXT NOT NULL,
    owned_checkout_json TEXT NOT NULL,
    runtime_close_operation_id TEXT UNIQUE
        REFERENCES agent_runtime_closes(operation_id) ON DELETE RESTRICT,
    terminal_workspace_receipt_json TEXT,
    planned_at_ms INTEGER NOT NULL CHECK (planned_at_ms >= 0),
    authorized_at_ms INTEGER,
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= planned_at_ms),
    CHECK (
        (
            state = 'planned'
            AND journal_revision = 1
            AND runtime_close_operation_id IS NULL
            AND terminal_workspace_receipt_json IS NULL
            AND authorized_at_ms IS NULL
        )
        OR (
            state = 'superseded'
            AND journal_revision = 2
            AND runtime_close_operation_id IS NULL
            AND terminal_workspace_receipt_json IS NULL
            AND authorized_at_ms IS NULL
        )
        OR (
            state = 'authorized'
            AND journal_revision = 2
            AND runtime_close_operation_id IS NOT NULL
            AND terminal_workspace_receipt_json IS NULL
            AND authorized_at_ms IS NOT NULL
        )
        OR (
            state = 'succeeded'
            AND journal_revision = 3
            AND runtime_close_operation_id IS NOT NULL
            AND terminal_workspace_receipt_json IS NOT NULL
            AND authorized_at_ms IS NOT NULL
        )
        OR (
            state IN ('source_retained', 'workspace_replaced')
            AND journal_revision = 3
            AND runtime_close_operation_id IS NOT NULL
            AND terminal_workspace_receipt_json IS NULL
            AND authorized_at_ms IS NOT NULL
        )
    ),
    CHECK (authorized_at_ms IS NULL OR (
        authorized_at_ms >= planned_at_ms AND updated_at_ms >= authorized_at_ms
    ))
)
"#;

pub(crate) const CREATE_AGENT_DISPATCH_STOPS: &str = r#"
CREATE TABLE IF NOT EXISTS agent_dispatch_stops (
    operation_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE RESTRICT,
    spawn_operation_id TEXT NOT NULL,
    plan_token TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (
        state IN (
            'planned',
            'superseded',
            'authorized',
            'succeeded',
            'source_retained',
            'workspace_preserved',
            'workspace_replaced'
        )
    ),
    journal_revision INTEGER NOT NULL CHECK (journal_revision > 0),
    runtime_selection_json TEXT NOT NULL,
    runtime_authority_json TEXT NOT NULL,
    workspace_action_json TEXT NOT NULL,
    runtime_close_operation_id TEXT UNIQUE
        REFERENCES agent_runtime_closes(operation_id) ON DELETE RESTRICT,
    terminal_workspace_receipt_json TEXT,
    planned_at_ms INTEGER NOT NULL CHECK (planned_at_ms >= 0),
    authorized_at_ms INTEGER,
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= planned_at_ms),
    CHECK (
        CASE
            WHEN json_valid(workspace_action_json) = 0 THEN 0
            WHEN json_extract(
                workspace_action_json,
                '$.workspaceDisposition'
            ) = 'preserve' THEN
                json_type(workspace_action_json, '$.ownedCheckout') IS NULL
            WHEN json_extract(
                workspace_action_json,
                '$.workspaceDisposition'
            ) = 'remove_owned' THEN
                COALESCE(
                    json_type(workspace_action_json, '$.ownedCheckout') = 'object',
                    0
                )
            ELSE 0
        END
    ),
    CHECK (
        (
            state = 'planned'
            AND journal_revision = 1
            AND runtime_close_operation_id IS NULL
            AND terminal_workspace_receipt_json IS NULL
            AND authorized_at_ms IS NULL
        )
        OR (
            state = 'superseded'
            AND journal_revision = 2
            AND runtime_close_operation_id IS NULL
            AND terminal_workspace_receipt_json IS NULL
            AND authorized_at_ms IS NULL
        )
        OR (
            state = 'authorized'
            AND journal_revision = 2
            AND runtime_close_operation_id IS NOT NULL
            AND terminal_workspace_receipt_json IS NULL
            AND authorized_at_ms IS NOT NULL
        )
        OR (
            state = 'succeeded'
            AND json_extract(
                workspace_action_json,
                '$.workspaceDisposition'
            ) = 'remove_owned'
            AND journal_revision = 3
            AND runtime_close_operation_id IS NOT NULL
            AND terminal_workspace_receipt_json IS NOT NULL
            AND authorized_at_ms IS NOT NULL
        )
        OR (
            state = 'source_retained'
            AND journal_revision = 3
            AND runtime_close_operation_id IS NOT NULL
            AND terminal_workspace_receipt_json IS NULL
            AND authorized_at_ms IS NOT NULL
        )
        OR (
            state = 'workspace_preserved'
            AND json_extract(
                workspace_action_json,
                '$.workspaceDisposition'
            ) = 'preserve'
            AND journal_revision = 3
            AND runtime_close_operation_id IS NOT NULL
            AND terminal_workspace_receipt_json IS NULL
            AND authorized_at_ms IS NOT NULL
        )
        OR (
            state = 'workspace_replaced'
            AND json_extract(
                workspace_action_json,
                '$.workspaceDisposition'
            ) = 'remove_owned'
            AND journal_revision = 3
            AND runtime_close_operation_id IS NOT NULL
            AND terminal_workspace_receipt_json IS NULL
            AND authorized_at_ms IS NOT NULL
        )
    ),
    CHECK (authorized_at_ms IS NULL OR (
        authorized_at_ms >= planned_at_ms AND updated_at_ms >= authorized_at_ms
    ))
)
"#;

pub(crate) const CREATE_AGENT_DISPATCH_STOPS_ACTIVE_AGENT_INDEX: &str = r#"
CREATE UNIQUE INDEX IF NOT EXISTS agent_dispatch_stops_active_agent_idx
ON agent_dispatch_stops (agent_id)
WHERE state IN ('planned', 'authorized')
"#;

pub(crate) const CREATE_AGENT_DISPATCH_STOPS_ACTIVE_SPAWN_INDEX: &str = r#"
CREATE UNIQUE INDEX IF NOT EXISTS agent_dispatch_stops_active_spawn_idx
ON agent_dispatch_stops (spawn_operation_id)
WHERE state IN ('planned', 'authorized')
"#;

pub(crate) const CREATE_AGENT_DISPATCH_STOPS_SPAWN_HISTORY_INDEX: &str = r#"
CREATE INDEX IF NOT EXISTS agent_dispatch_stops_spawn_history_idx
ON agent_dispatch_stops (spawn_operation_id, planned_at_ms DESC, operation_id DESC)
"#;

pub(crate) const CREATE_AGENT_DISPATCH_STOPS_RECOVERY_INDEX: &str = r#"
CREATE INDEX IF NOT EXISTS agent_dispatch_stops_recovery_idx
ON agent_dispatch_stops (state, updated_at_ms, operation_id)
"#;

const DROP_AGENT_DISPATCH_STOPS_ACTIVE_AGENT_INDEX_V33: &str =
    "DROP INDEX IF EXISTS agent_dispatch_stops_active_agent_idx";
const DROP_AGENT_DISPATCH_STOPS_ACTIVE_SPAWN_INDEX_V33: &str =
    "DROP INDEX IF EXISTS agent_dispatch_stops_active_spawn_idx";
const DROP_AGENT_DISPATCH_STOPS_SPAWN_HISTORY_INDEX_V33: &str =
    "DROP INDEX IF EXISTS agent_dispatch_stops_spawn_history_idx";
const DROP_AGENT_DISPATCH_STOPS_RECOVERY_INDEX_V33: &str =
    "DROP INDEX IF EXISTS agent_dispatch_stops_recovery_idx";
const RENAME_AGENT_DISPATCH_STOPS_V33: &str =
    "ALTER TABLE agent_dispatch_stops RENAME TO agent_dispatch_stops_v33";
const COPY_AGENT_DISPATCH_STOPS_V33: &str = r#"
INSERT INTO agent_dispatch_stops (
    operation_id, agent_id, spawn_operation_id, plan_token, state,
    journal_revision, runtime_selection_json, runtime_authority_json,
    owned_checkout_json, runtime_close_operation_id,
    terminal_workspace_receipt_json, planned_at_ms, authorized_at_ms,
    updated_at_ms
)
SELECT
    operation_id, agent_id, spawn_operation_id, plan_token, state,
    journal_revision, runtime_selection_json, runtime_authority_json,
    owned_checkout_json, runtime_close_operation_id,
    terminal_workspace_receipt_json, planned_at_ms, authorized_at_ms,
    updated_at_ms
FROM agent_dispatch_stops_v33
"#;
const DROP_AGENT_DISPATCH_STOPS_V33: &str = "DROP TABLE agent_dispatch_stops_v33";

const DROP_AGENT_DISPATCH_STOPS_ACTIVE_AGENT_INDEX_V34: &str =
    "DROP INDEX IF EXISTS agent_dispatch_stops_active_agent_idx";
const DROP_AGENT_DISPATCH_STOPS_ACTIVE_SPAWN_INDEX_V34: &str =
    "DROP INDEX IF EXISTS agent_dispatch_stops_active_spawn_idx";
const DROP_AGENT_DISPATCH_STOPS_SPAWN_HISTORY_INDEX_V34: &str =
    "DROP INDEX IF EXISTS agent_dispatch_stops_spawn_history_idx";
const DROP_AGENT_DISPATCH_STOPS_RECOVERY_INDEX_V34: &str =
    "DROP INDEX IF EXISTS agent_dispatch_stops_recovery_idx";
const RENAME_AGENT_DISPATCH_STOPS_V34: &str =
    "ALTER TABLE agent_dispatch_stops RENAME TO agent_dispatch_stops_v34";
const COPY_AGENT_DISPATCH_STOPS_V34: &str = r#"
INSERT INTO agent_dispatch_stops (
    operation_id, agent_id, spawn_operation_id, plan_token, state,
    journal_revision, runtime_selection_json, runtime_authority_json,
    workspace_action_json, runtime_close_operation_id,
    terminal_workspace_receipt_json, planned_at_ms, authorized_at_ms,
    updated_at_ms
)
SELECT
    operation_id, agent_id, spawn_operation_id, plan_token, state,
    journal_revision, runtime_selection_json, runtime_authority_json,
    '{"workspaceDisposition":"remove_owned","ownedCheckout":'
        || owned_checkout_json || '}',
    runtime_close_operation_id,
    terminal_workspace_receipt_json, planned_at_ms, authorized_at_ms,
    updated_at_ms
FROM agent_dispatch_stops_v34
"#;
const DROP_AGENT_DISPATCH_STOPS_V34: &str = "DROP TABLE agent_dispatch_stops_v34";

const DROP_AGENT_RUNTIME_CLOSES_ACTIVE_INDEX: &str =
    "DROP INDEX IF EXISTS agent_runtime_closes_active_idx";

const RENAME_AGENT_RUNTIME_CLOSES_V28: &str =
    "ALTER TABLE agent_runtime_closes RENAME TO agent_runtime_closes_v28";

const COPY_AGENT_RUNTIME_CLOSES_V28: &str = r#"
INSERT INTO agent_runtime_closes (
    operation_id,
    idempotency_key,
    agent_id,
    state,
    journal_revision,
    record_json,
    created_at_ms,
    updated_at_ms
)
SELECT
    operation_id,
    idempotency_key,
    agent_id,
    state,
    journal_revision,
    record_json,
    created_at_ms,
    updated_at_ms
FROM agent_runtime_closes_v28
"#;

const DROP_AGENT_RUNTIME_CLOSES_V28: &str = "DROP TABLE agent_runtime_closes_v28";

const CREATE_AGENT_CHECKPOINT_BINDING_AUTHORITIES: &str = r#"
CREATE TABLE IF NOT EXISTS agent_checkpoint_binding_authorities (
    agent_id TEXT PRIMARY KEY REFERENCES session_bindings(agent_id) ON DELETE CASCADE,
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    session_id TEXT NOT NULL,
    runtime_workspace_id TEXT NOT NULL,
    runner_principal TEXT NOT NULL,
    runner_instance TEXT NOT NULL,
    channel_epoch TEXT NOT NULL,
    host_instance_id TEXT NOT NULL,
    terminal_epoch TEXT NOT NULL,
    binding_generation INTEGER NOT NULL CHECK (binding_generation > 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
)
"#;

const CREATE_AGENT_CHECKPOINTS: &str = r#"
CREATE TABLE IF NOT EXISTS agent_checkpoints (
    agent_id TEXT PRIMARY KEY REFERENCES agents(agent_id) ON DELETE CASCADE,
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    checkpoint_text TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    updated_by_session_id TEXT NOT NULL,
    updated_by_binding_generation INTEGER NOT NULL
        CHECK (updated_by_binding_generation > 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
)
"#;

const CREATE_AGENT_CHECKPOINT_RECEIPTS: &str = r#"
CREATE TABLE IF NOT EXISTS agent_checkpoint_receipts (
    idempotency_key TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    binding_generation INTEGER NOT NULL CHECK (binding_generation > 0),
    expected_revision INTEGER NOT NULL CHECK (expected_revision >= 0),
    checkpoint_text TEXT NOT NULL,
    result_revision INTEGER NOT NULL CHECK (result_revision > 0),
    result_updated_at_ms INTEGER NOT NULL CHECK (result_updated_at_ms >= 0)
)
"#;

const CREATE_CLIENT_VIEW_AUTHORITIES: &str = r#"
CREATE TABLE IF NOT EXISTS client_view_authorities (
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    client_generation INTEGER NOT NULL CHECK (client_generation > 0),
    client_instance_id TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    PRIMARY KEY (tenant_id, user_id, client_id)
)
"#;

const CREATE_CLIENT_VIEW_GENERATION_RECEIPTS: &str = r#"
CREATE TABLE IF NOT EXISTS client_view_generation_receipts (
    idempotency_key TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    expected_generation INTEGER NOT NULL CHECK (expected_generation >= 0),
    expected_instance_id TEXT,
    next_instance_id TEXT NOT NULL,
    result_generation INTEGER NOT NULL CHECK (result_generation > 0),
    result_updated_at_ms INTEGER NOT NULL CHECK (result_updated_at_ms >= 0)
)
"#;

const CREATE_CLIENT_VIEWS: &str = r#"
CREATE TABLE IF NOT EXISTS client_views (
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    view_id TEXT NOT NULL,
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    client_generation INTEGER NOT NULL CHECK (client_generation > 0),
    client_instance_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    presentation_json TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    PRIMARY KEY (tenant_id, user_id, client_id, view_id),
    FOREIGN KEY (tenant_id, user_id, client_id)
        REFERENCES client_view_authorities(tenant_id, user_id, client_id)
        ON DELETE CASCADE
)
"#;

const CREATE_CLIENT_VIEW_WRITE_RECEIPTS: &str = r#"
CREATE TABLE IF NOT EXISTS client_view_write_receipts (
    idempotency_key TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    client_generation INTEGER NOT NULL CHECK (client_generation > 0),
    client_instance_id TEXT NOT NULL,
    view_id TEXT NOT NULL,
    expected_revision INTEGER NOT NULL CHECK (expected_revision >= 0),
    presentation_json TEXT NOT NULL,
    result_revision INTEGER NOT NULL CHECK (result_revision > 0),
    result_updated_at_ms INTEGER NOT NULL CHECK (result_updated_at_ms >= 0)
)
"#;

const CREATE_OPERATION_EVENTS: &str = r#"
CREATE TABLE IF NOT EXISTS operation_events (
    event_id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    body_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    UNIQUE (operation_id, sequence)
)
"#;

const CREATE_OPERATION_RECEIPTS: &str = r#"
CREATE TABLE IF NOT EXISTS operation_receipts (
    operation_id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    operation_kind TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('running', 'succeeded', 'failed')),
    last_sequence INTEGER NOT NULL CHECK (last_sequence > 0),
    current_stage TEXT,
    terminal_code TEXT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
)
"#;

const CREATE_AGENT_SPAWN_EVENTS_V12_TO_V31: &str = r#"
CREATE TABLE IF NOT EXISTS agent_spawn_events (
    event_id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    plan_token TEXT NOT NULL,
    idempotency_key TEXT UNIQUE,
    body_json TEXT NOT NULL,
    recorded_at_ms INTEGER NOT NULL CHECK (recorded_at_ms >= 0),
    UNIQUE (operation_id, sequence),
    CHECK (
        (sequence = 1 AND idempotency_key IS NOT NULL)
        OR (sequence > 1 AND idempotency_key IS NULL)
    )
)
"#;

const CREATE_AGENT_SPAWN_EVENTS: &str = r#"
CREATE TABLE IF NOT EXISTS agent_spawn_events (
    event_id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    plan_token TEXT NOT NULL,
    idempotency_key TEXT UNIQUE,
    agent_id TEXT UNIQUE,
    body_json TEXT NOT NULL,
    recorded_at_ms INTEGER NOT NULL CHECK (recorded_at_ms >= 0),
    UNIQUE (operation_id, sequence),
    CHECK (
        (
            sequence = 1
            AND idempotency_key IS NOT NULL
            AND agent_id IS NOT NULL
        )
        OR
        (
            sequence > 1
            AND idempotency_key IS NULL
            AND agent_id IS NULL
        )
    )
)
"#;

const RENAME_AGENT_SPAWN_EVENTS_V31: &str =
    "ALTER TABLE agent_spawn_events RENAME TO agent_spawn_events_v31";

const COPY_AGENT_SPAWN_EVENTS_V31: &str = r#"
INSERT INTO agent_spawn_events (
    event_id,
    operation_id,
    sequence,
    plan_token,
    idempotency_key,
    agent_id,
    body_json,
    recorded_at_ms
)
SELECT
    event_id,
    operation_id,
    sequence,
    plan_token,
    idempotency_key,
    CASE
        WHEN sequence = 1 THEN json_extract(body_json, '$.plan.agentId')
        ELSE NULL
    END,
    body_json,
    recorded_at_ms
FROM agent_spawn_events_v31
"#;

const DROP_AGENT_SPAWN_EVENTS_V31: &str = "DROP TABLE agent_spawn_events_v31";

const CREATE_AGENT_SPAWN_RECEIPTS: &str = r#"
CREATE TABLE IF NOT EXISTS agent_spawn_receipts (
    operation_id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    plan_token TEXT NOT NULL,
    state TEXT NOT NULL CHECK (
        state IN (
            'applying',
            'ready_to_succeed',
            'inspect_before_retry',
            'retry_required',
            'prompt_delivery_uncertain',
            'succeeded',
            'failed',
            'manual_intervention_required'
        )
    ),
    last_sequence INTEGER NOT NULL CHECK (last_sequence > 0),
    receipt_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
)
"#;

const CREATE_PROVIDER_LAUNCH_DEFAULTS: &str = r#"
CREATE TABLE IF NOT EXISTS provider_launch_defaults (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    revision INTEGER NOT NULL CHECK (revision > 0),
    defaults_json TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
)
"#;

const CREATE_PROVIDER_LAUNCH_DEFAULTS_PUT_RECEIPTS: &str = r#"
CREATE TABLE IF NOT EXISTS provider_launch_defaults_put_receipts (
    idempotency_key TEXT PRIMARY KEY,
    request_json TEXT NOT NULL,
    receipt_json TEXT NOT NULL
)
"#;

pub(crate) const CREATE_PROVIDER_CREDENTIAL_PROFILES: &str = r#"
CREATE TABLE IF NOT EXISTS provider_credential_profiles (
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    provider_id TEXT NOT NULL,
    reference_id TEXT NOT NULL,
    profile_directory_name TEXT NOT NULL,
    credential_generation TEXT NOT NULL,
    profile_device TEXT NOT NULL,
    profile_inode TEXT NOT NULL,
    PRIMARY KEY (provider_id, reference_id),
    UNIQUE (provider_id, profile_directory_name)
)
"#;

const NORMALIZE_LEGACY_AGENT_PROVIDER_IDS: &str = r#"
UPDATE agents
SET provider_id = substr(provider_id, length('provider.') + 1)
WHERE provider_id GLOB 'provider.?*'
"#;

const CREATE_REVIEW_TARGETS: &str = r#"
CREATE TABLE IF NOT EXISTS review_targets (
    review_id TEXT PRIMARY KEY,
    worktree_path TEXT NOT NULL,
    worktree_git_dir TEXT NOT NULL,
    base_ref TEXT NOT NULL,
    base_commit_sha TEXT NOT NULL,
    head_commit_sha TEXT NOT NULL,
    source_session_id TEXT,
    feedback_agent_id TEXT,
    created_at_ms INTEGER NOT NULL
)
"#;

const CREATE_REVIEW_TARGET_LIFECYCLE: &str = r#"
CREATE TABLE IF NOT EXISTS review_target_lifecycle (
    review_id TEXT PRIMARY KEY REFERENCES review_targets(review_id) ON DELETE CASCADE,
    inactive_since_ms INTEGER,
    observed_at_ms INTEGER NOT NULL,
    CHECK (inactive_since_ms IS NULL OR inactive_since_ms <= observed_at_ms)
)
"#;

const CREATE_PLUGIN_APPLY_EVENTS: &str = r#"
CREATE TABLE IF NOT EXISTS plugin_apply_events (
    event_id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    body_json TEXT NOT NULL,
    recorded_at_ms INTEGER NOT NULL CHECK (recorded_at_ms >= 0),
    UNIQUE (operation_id, sequence)
)
"#;

const CREATE_PLUGIN_APPLY_RECEIPTS_V5_V6: &str = r#"
CREATE TABLE IF NOT EXISTS plugin_apply_receipts (
    operation_id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    plugin_id TEXT NOT NULL,
    plugin_version TEXT NOT NULL,
    operation_kind TEXT NOT NULL CHECK (operation_kind IN ('install', 'uninstall')),
    state TEXT NOT NULL CHECK (
        state IN (
            'applying',
            'inspect_before_retry',
            'recovery_required',
            'compensating',
            'succeeded'
        )
    ),
    last_sequence INTEGER NOT NULL CHECK (last_sequence > 0),
    receipt_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
)
"#;

const CREATE_PLUGIN_APPLY_RECEIPTS: &str = r#"
CREATE TABLE IF NOT EXISTS plugin_apply_receipts (
    operation_id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    plugin_id TEXT NOT NULL,
    plugin_version TEXT NOT NULL,
    operation_kind TEXT NOT NULL CHECK (operation_kind IN ('install', 'uninstall')),
    state TEXT NOT NULL CHECK (
        state IN (
            'applying',
            'inspect_before_retry',
            'recovery_required',
            'compensating',
            'compensated',
            'succeeded'
        )
    ),
    last_sequence INTEGER NOT NULL CHECK (last_sequence > 0),
    receipt_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
)
"#;

const RENAME_PLUGIN_APPLY_RECEIPTS_V6: &str =
    "ALTER TABLE plugin_apply_receipts RENAME TO plugin_apply_receipts_v6";

const COPY_PLUGIN_APPLY_RECEIPTS_V6: &str = r#"
INSERT INTO plugin_apply_receipts (
    operation_id,
    idempotency_key,
    plugin_id,
    plugin_version,
    operation_kind,
    state,
    last_sequence,
    receipt_json,
    created_at_ms,
    updated_at_ms
)
SELECT
    operation_id,
    idempotency_key,
    plugin_id,
    plugin_version,
    operation_kind,
    state,
    last_sequence,
    receipt_json,
    created_at_ms,
    updated_at_ms
FROM plugin_apply_receipts_v6
"#;

const DROP_PLUGIN_APPLY_RECEIPTS_V6: &str = "DROP TABLE plugin_apply_receipts_v6";

const CREATE_PLUGIN_NATIVE_OWNERSHIP_EVENTS: &str = r#"
CREATE TABLE IF NOT EXISTS plugin_native_ownership_events (
    revision INTEGER PRIMARY KEY AUTOINCREMENT,
    journal_event_id TEXT NOT NULL UNIQUE
        REFERENCES plugin_apply_events(event_id) ON DELETE RESTRICT,
    operation_id TEXT NOT NULL,
    step_index INTEGER NOT NULL CHECK (step_index >= 0),
    attempt INTEGER NOT NULL CHECK (attempt > 0),
    ownership_key TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('claimed', 'released')),
    body_json TEXT NOT NULL,
    recorded_at_ms INTEGER NOT NULL CHECK (recorded_at_ms >= 0)
)
"#;

const CREATE_PLUGIN_NATIVE_OWNERSHIP: &str = r#"
CREATE TABLE IF NOT EXISTS plugin_native_ownership (
    ownership_key TEXT PRIMARY KEY,
    ledger_revision INTEGER NOT NULL UNIQUE
        REFERENCES plugin_native_ownership_events(revision) ON DELETE RESTRICT,
    receipt_json TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
)
"#;

pub(crate) const CREATE_PLUGIN_NATIVE_TARGET_BINDINGS: &str = r#"
CREATE TABLE IF NOT EXISTS plugin_native_target_bindings (
    physical_target_key TEXT PRIMARY KEY,
    role TEXT NOT NULL CHECK (role IN ('profile_root', 'workspace_root')),
    canonical_path_identity TEXT NOT NULL UNIQUE,
    filesystem_object_identity TEXT NOT NULL UNIQUE,
    authority_generation_identity TEXT NOT NULL,
    authority_identity TEXT NOT NULL,
    binding_identity TEXT NOT NULL,
    bound_by_operation_id TEXT NOT NULL,
    bound_by_event_id TEXT NOT NULL
        REFERENCES plugin_apply_events(event_id) ON DELETE RESTRICT,
    bound_at_ms INTEGER NOT NULL CHECK (bound_at_ms >= 0)
)
"#;

const CREATE_WORKFLOW_RUNS: &str = r#"
CREATE TABLE IF NOT EXISTS workflow_runs (
    run_id TEXT PRIMARY KEY,
    contribution_id TEXT NOT NULL,
    coordinator_agent_id TEXT NOT NULL,
    coordinator_session_id TEXT NOT NULL,
    coordinator_binding_generation INTEGER NOT NULL
        CHECK (coordinator_binding_generation > 0),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
)
"#;

const CREATE_WORKFLOW_TASKS: &str = r#"
CREATE TABLE IF NOT EXISTS workflow_tasks (
    task_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES workflow_runs(run_id) ON DELETE RESTRICT,
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    summary TEXT NOT NULL,
    instructions TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('dispatched', 'completed')),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
)
"#;

const CREATE_WORKFLOW_DISPATCHES_V13_TO_V16: &str = r#"
CREATE TABLE IF NOT EXISTS workflow_dispatches (
    dispatch_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES workflow_tasks(task_id) ON DELETE RESTRICT,
    provider_id TEXT NOT NULL,
    runtime_kind_id TEXT NOT NULL,
    target_reference TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation > 0),
    state TEXT NOT NULL CHECK (state IN ('starting', 'completed')),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    UNIQUE (task_id, generation)
)
"#;

const ADD_WORKFLOW_COMPLETION_RESULT: &str =
    "ALTER TABLE workflow_dispatches ADD COLUMN completion_result TEXT";

const CREATE_WORKFLOW_DELEGATE_ONCE_RECEIPTS: &str = r#"
CREATE TABLE IF NOT EXISTS workflow_delegate_once_receipts (
    idempotency_key TEXT PRIMARY KEY,
    request_digest TEXT NOT NULL UNIQUE,
    run_id TEXT NOT NULL UNIQUE REFERENCES workflow_runs(run_id) ON DELETE RESTRICT,
    task_id TEXT NOT NULL UNIQUE REFERENCES workflow_tasks(task_id) ON DELETE RESTRICT,
    dispatch_id TEXT NOT NULL UNIQUE
        REFERENCES workflow_dispatches(dispatch_id) ON DELETE RESTRICT
)
"#;

const CREATE_WORKFLOW_DISPATCH_LAUNCHES_V13: &str = r#"
CREATE TABLE IF NOT EXISTS workflow_dispatch_launches (
    dispatch_id TEXT PRIMARY KEY
        REFERENCES workflow_dispatches(dispatch_id) ON DELETE RESTRICT,
    launch_idempotency_key TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (state IN ('starting', 'active', 'start_failed')),
    session_id TEXT,
    workspace_id TEXT,
    provider_id TEXT,
    runner_principal TEXT,
    runner_instance TEXT,
    channel_epoch TEXT,
    host_instance_id TEXT,
    terminal_epoch TEXT,
    start_error_code TEXT,
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    CHECK (
        (
            state = 'starting'
            AND session_id IS NULL
            AND workspace_id IS NULL
            AND provider_id IS NULL
            AND runner_principal IS NULL
            AND runner_instance IS NULL
            AND channel_epoch IS NULL
            AND host_instance_id IS NULL
            AND terminal_epoch IS NULL
            AND start_error_code IS NULL
        )
        OR
        (
            state = 'active'
            AND session_id IS NOT NULL
            AND workspace_id IS NOT NULL
            AND provider_id IS NOT NULL
            AND runner_principal IS NOT NULL
            AND runner_instance IS NOT NULL
            AND channel_epoch IS NOT NULL
            AND host_instance_id IS NOT NULL
            AND terminal_epoch IS NOT NULL
            AND start_error_code IS NULL
        )
        OR
        (
            state = 'start_failed'
            AND session_id IS NULL
            AND workspace_id IS NULL
            AND provider_id IS NULL
            AND runner_principal IS NULL
            AND runner_instance IS NULL
            AND channel_epoch IS NULL
            AND host_instance_id IS NULL
            AND terminal_epoch IS NULL
            AND start_error_code IS NOT NULL
        )
    )
)
"#;

const ADD_WORKFLOW_EFFECTIVE_LAUNCH_IDEMPOTENCY_KEY: &str =
    "ALTER TABLE workflow_dispatch_launches ADD COLUMN effective_launch_idempotency_key TEXT";

const BACKFILL_WORKFLOW_EFFECTIVE_LAUNCH_IDEMPOTENCY_KEY: &str = r#"
UPDATE workflow_dispatch_launches
SET effective_launch_idempotency_key = launch_idempotency_key
WHERE state = 'active'
  AND delivery_mode = 'pty_prompt'
  AND session_id = 'workflow-' || substr(dispatch_id, 10, 32)
"#;

const RENAME_WORKFLOW_DISPATCH_LAUNCHES_V13: &str =
    "ALTER TABLE workflow_dispatch_launches RENAME TO workflow_dispatch_launches_v13";

const CREATE_WORKFLOW_DISPATCH_LAUNCHES_V15_TO_V18: &str = r#"
CREATE TABLE IF NOT EXISTS workflow_dispatch_launches (
    dispatch_id TEXT PRIMARY KEY
        REFERENCES workflow_dispatches(dispatch_id) ON DELETE RESTRICT,
    launch_idempotency_key TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (state IN ('starting', 'active', 'start_failed')),
    session_id TEXT,
    workspace_id TEXT,
    provider_id TEXT,
    runner_principal TEXT,
    runner_instance TEXT,
    channel_epoch TEXT,
    host_instance_id TEXT,
    terminal_epoch TEXT,
    start_error_code TEXT,
    prompt_delivery_idempotency_key TEXT UNIQUE,
    prompt_delivery_state TEXT CHECK (
        prompt_delivery_state IN ('pending', 'uncertain', 'written_to_pty', 'failed')
    ),
    prompt_delivery_evidence_json TEXT,
    prompt_delivery_error_code TEXT,
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    CHECK (
        (
            state = 'starting'
            AND session_id IS NULL
            AND workspace_id IS NULL
            AND provider_id IS NULL
            AND runner_principal IS NULL
            AND runner_instance IS NULL
            AND channel_epoch IS NULL
            AND host_instance_id IS NULL
            AND terminal_epoch IS NULL
            AND start_error_code IS NULL
            AND prompt_delivery_idempotency_key IS NULL
            AND prompt_delivery_state IS NULL
            AND prompt_delivery_evidence_json IS NULL
            AND prompt_delivery_error_code IS NULL
        )
        OR
        (
            state = 'active'
            AND session_id IS NOT NULL
            AND workspace_id IS NOT NULL
            AND provider_id IS NOT NULL
            AND runner_principal IS NOT NULL
            AND runner_instance IS NOT NULL
            AND channel_epoch IS NOT NULL
            AND host_instance_id IS NOT NULL
            AND terminal_epoch IS NOT NULL
            AND start_error_code IS NULL
            AND prompt_delivery_idempotency_key IS NOT NULL
            AND (
                (
                    prompt_delivery_state IN ('pending', 'uncertain')
                    AND prompt_delivery_evidence_json IS NULL
                    AND prompt_delivery_error_code IS NULL
                )
                OR
                (
                    prompt_delivery_state = 'written_to_pty'
                    AND prompt_delivery_evidence_json IS NOT NULL
                    AND prompt_delivery_error_code IS NULL
                )
                OR
                (
                    prompt_delivery_state = 'failed'
                    AND prompt_delivery_evidence_json IS NULL
                    AND prompt_delivery_error_code IS NOT NULL
                )
            )
        )
        OR
        (
            state = 'start_failed'
            AND session_id IS NULL
            AND workspace_id IS NULL
            AND provider_id IS NULL
            AND runner_principal IS NULL
            AND runner_instance IS NULL
            AND channel_epoch IS NULL
            AND host_instance_id IS NULL
            AND terminal_epoch IS NULL
            AND start_error_code IS NOT NULL
            AND prompt_delivery_idempotency_key IS NULL
            AND prompt_delivery_state IS NULL
            AND prompt_delivery_evidence_json IS NULL
            AND prompt_delivery_error_code IS NULL
        )
    )
)
"#;

const RENAME_WORKFLOW_DISPATCH_LAUNCHES_V18: &str =
    "ALTER TABLE workflow_dispatch_launches RENAME TO workflow_dispatch_launches_v18";

const CREATE_WORKFLOW_DISPATCH_LAUNCHES_V19_TO_V31: &str = r#"
CREATE TABLE IF NOT EXISTS workflow_dispatch_launches (
    dispatch_id TEXT PRIMARY KEY
        REFERENCES workflow_dispatches(dispatch_id) ON DELETE RESTRICT,
    launch_idempotency_key TEXT NOT NULL UNIQUE,
    delivery_mode TEXT NOT NULL DEFAULT 'pty_prompt'
        CHECK (delivery_mode IN ('pty_prompt', 'durable_inbox')),
    state TEXT NOT NULL CHECK (state IN ('starting', 'active', 'start_failed')),
    session_id TEXT,
    workspace_id TEXT,
    provider_id TEXT,
    runner_principal TEXT,
    runner_instance TEXT,
    channel_epoch TEXT,
    host_instance_id TEXT,
    terminal_epoch TEXT,
    start_error_code TEXT,
    prompt_delivery_idempotency_key TEXT UNIQUE,
    prompt_delivery_state TEXT CHECK (
        prompt_delivery_state IN ('pending', 'uncertain', 'written_to_pty', 'failed')
    ),
    prompt_delivery_evidence_json TEXT,
    prompt_delivery_error_code TEXT,
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    CHECK (
        (
            state = 'starting'
            AND delivery_mode = 'pty_prompt'
            AND session_id IS NULL
            AND workspace_id IS NULL
            AND provider_id IS NULL
            AND runner_principal IS NULL
            AND runner_instance IS NULL
            AND channel_epoch IS NULL
            AND host_instance_id IS NULL
            AND terminal_epoch IS NULL
            AND start_error_code IS NULL
            AND prompt_delivery_idempotency_key IS NULL
            AND prompt_delivery_state IS NULL
            AND prompt_delivery_evidence_json IS NULL
            AND prompt_delivery_error_code IS NULL
        )
        OR
        (
            state = 'active'
            AND session_id IS NOT NULL
            AND workspace_id IS NOT NULL
            AND provider_id IS NOT NULL
            AND runner_principal IS NOT NULL
            AND runner_instance IS NOT NULL
            AND channel_epoch IS NOT NULL
            AND host_instance_id IS NOT NULL
            AND terminal_epoch IS NOT NULL
            AND start_error_code IS NULL
            AND (
                (
                    delivery_mode = 'durable_inbox'
                    AND prompt_delivery_idempotency_key IS NULL
                    AND prompt_delivery_state IS NULL
                    AND prompt_delivery_evidence_json IS NULL
                    AND prompt_delivery_error_code IS NULL
                )
                OR
                (
                    delivery_mode = 'pty_prompt'
                    AND prompt_delivery_idempotency_key IS NOT NULL
                    AND (
                        (
                            prompt_delivery_state IN ('pending', 'uncertain')
                            AND prompt_delivery_evidence_json IS NULL
                            AND prompt_delivery_error_code IS NULL
                        )
                        OR
                        (
                            prompt_delivery_state = 'written_to_pty'
                            AND prompt_delivery_evidence_json IS NOT NULL
                            AND prompt_delivery_error_code IS NULL
                        )
                        OR
                        (
                            prompt_delivery_state = 'failed'
                            AND prompt_delivery_evidence_json IS NULL
                            AND prompt_delivery_error_code IS NOT NULL
                        )
                    )
                )
            )
        )
        OR
        (
            state = 'start_failed'
            AND delivery_mode = 'pty_prompt'
            AND session_id IS NULL
            AND workspace_id IS NULL
            AND provider_id IS NULL
            AND runner_principal IS NULL
            AND runner_instance IS NULL
            AND channel_epoch IS NULL
            AND host_instance_id IS NULL
            AND terminal_epoch IS NULL
            AND start_error_code IS NOT NULL
            AND prompt_delivery_idempotency_key IS NULL
            AND prompt_delivery_state IS NULL
            AND prompt_delivery_evidence_json IS NULL
            AND prompt_delivery_error_code IS NULL
        )
    )
)
"#;

const CREATE_WORKFLOW_DISPATCH_LAUNCHES_ACTIVE_SESSION_INDEX: &str = r#"
CREATE INDEX IF NOT EXISTS workflow_dispatch_launches_active_session_idx
ON workflow_dispatch_launches (
    session_id,
    workspace_id,
    provider_id,
    runner_principal,
    runner_instance,
    channel_epoch,
    host_instance_id,
    terminal_epoch
)
WHERE state = 'active'
"#;

const COPY_WORKFLOW_DISPATCH_LAUNCHES_V18: &str = r#"
INSERT INTO workflow_dispatch_launches (
    dispatch_id,
    launch_idempotency_key,
    delivery_mode,
    state,
    session_id,
    workspace_id,
    provider_id,
    runner_principal,
    runner_instance,
    channel_epoch,
    host_instance_id,
    terminal_epoch,
    start_error_code,
    prompt_delivery_idempotency_key,
    prompt_delivery_state,
    prompt_delivery_evidence_json,
    prompt_delivery_error_code,
    updated_at_ms
)
SELECT
    dispatch_id,
    launch_idempotency_key,
    'pty_prompt',
    state,
    session_id,
    workspace_id,
    provider_id,
    runner_principal,
    runner_instance,
    channel_epoch,
    host_instance_id,
    terminal_epoch,
    start_error_code,
    prompt_delivery_idempotency_key,
    prompt_delivery_state,
    prompt_delivery_evidence_json,
    prompt_delivery_error_code,
    updated_at_ms
FROM workflow_dispatch_launches_v18
"#;

const DROP_WORKFLOW_DISPATCH_LAUNCHES_V18: &str = "DROP TABLE workflow_dispatch_launches_v18";

const COPY_WORKFLOW_DISPATCH_LAUNCHES_V13: &str = r#"
INSERT INTO workflow_dispatch_launches (
    dispatch_id,
    launch_idempotency_key,
    state,
    session_id,
    workspace_id,
    provider_id,
    runner_principal,
    runner_instance,
    channel_epoch,
    host_instance_id,
    terminal_epoch,
    start_error_code,
    prompt_delivery_idempotency_key,
    prompt_delivery_state,
    updated_at_ms
)
SELECT
    dispatch_id,
    launch_idempotency_key,
    state,
    session_id,
    workspace_id,
    provider_id,
    runner_principal,
    runner_instance,
    channel_epoch,
    host_instance_id,
    terminal_epoch,
    start_error_code,
    CASE WHEN state = 'active' THEN 'prompt:' || launch_idempotency_key ELSE NULL END,
    CASE WHEN state = 'active' THEN 'uncertain' ELSE NULL END,
    updated_at_ms
FROM workflow_dispatch_launches_v13
"#;

const DROP_WORKFLOW_DISPATCH_LAUNCHES_V13: &str = "DROP TABLE workflow_dispatch_launches_v13";

const SEED_WORKFLOW_DISPATCH_LAUNCHES: &str = r#"
INSERT INTO workflow_dispatch_launches (
    dispatch_id,
    launch_idempotency_key,
    state,
    start_error_code,
    updated_at_ms
)
SELECT
    dispatch_id,
    'workflow:' || dispatch_id,
    CASE WHEN state = 'completed' THEN 'start_failed' ELSE 'starting' END,
    CASE
        WHEN state = 'completed' THEN 'legacy_session_generation_unavailable'
        ELSE NULL
    END,
    updated_at_ms
FROM workflow_dispatches
WHERE 1
ON CONFLICT(dispatch_id) DO NOTHING
"#;

const CREATE_WORKFLOW_INTERACTION_AUTHORITIES: &str = r#"
CREATE TABLE IF NOT EXISTS workflow_interaction_authorities (
    dispatch_id TEXT PRIMARY KEY
        REFERENCES workflow_dispatches(dispatch_id) ON DELETE RESTRICT,
    authority_key TEXT NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE RESTRICT,
    tenant_ref TEXT,
    revision INTEGER NOT NULL CHECK (revision > 0),
    blocked_by TEXT,
    interaction_capability TEXT NOT NULL,
    completion_capability TEXT NOT NULL,
    worker_endpoint_json TEXT NOT NULL,
    worker_session_json TEXT NOT NULL,
    coordinator_grant_json TEXT NOT NULL,
    coordinator_reply_capability TEXT NOT NULL,
    negotiation_idempotency_key TEXT NOT NULL,
    negotiation_digest TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    UNIQUE (authority_key, dispatch_id)
) WITHOUT ROWID
"#;

const CREATE_WORKFLOW_INTERACTIONS: &str = r#"
CREATE TABLE IF NOT EXISTS workflow_interactions (
    authority_key TEXT NOT NULL,
    interaction_id TEXT NOT NULL,
    dispatch_id TEXT NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY (authority_key, interaction_id),
    FOREIGN KEY (authority_key, dispatch_id)
        REFERENCES workflow_interaction_authorities(authority_key, dispatch_id)
        ON DELETE RESTRICT
) WITHOUT ROWID
"#;

const CREATE_WORKFLOW_INTERACTION_EVENTS: &str = r#"
CREATE TABLE IF NOT EXISTS workflow_interaction_events (
    authority_key TEXT NOT NULL,
    cursor INTEGER NOT NULL CHECK (cursor > 0),
    event_json TEXT NOT NULL,
    PRIMARY KEY (authority_key, cursor)
) WITHOUT ROWID
"#;

const CREATE_WORKFLOW_INTERACTION_DELIVERIES: &str = r#"
CREATE TABLE IF NOT EXISTS workflow_interaction_deliveries (
    authority_key TEXT NOT NULL,
    receipt_id TEXT NOT NULL,
    event_cursor INTEGER NOT NULL CHECK (event_cursor > 0),
    delivery_json TEXT NOT NULL,
    PRIMARY KEY (authority_key, receipt_id),
    FOREIGN KEY (authority_key, event_cursor)
        REFERENCES workflow_interaction_events(authority_key, cursor) ON DELETE RESTRICT
) WITHOUT ROWID
"#;

const CREATE_WORKFLOW_INTERACTION_IDEMPOTENCY: &str = r#"
CREATE TABLE IF NOT EXISTS workflow_interaction_idempotency (
    authority_key TEXT NOT NULL,
    operation_key TEXT NOT NULL,
    entry_json TEXT NOT NULL,
    PRIMARY KEY (authority_key, operation_key)
) WITHOUT ROWID
"#;

const CREATE_WORKFLOW_INTERACTION_ACKNOWLEDGEMENTS: &str = r#"
CREATE TABLE IF NOT EXISTS workflow_interaction_acknowledgements (
    authority_key TEXT NOT NULL,
    operation_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    PRIMARY KEY (authority_key, operation_key)
) WITHOUT ROWID
"#;

const CREATE_WORKFLOW_INTERACTION_CURSORS: &str = r#"
CREATE TABLE IF NOT EXISTS workflow_interaction_cursors (
    authority_key TEXT PRIMARY KEY,
    next_cursor INTEGER NOT NULL CHECK (next_cursor > 0)
) WITHOUT ROWID
"#;

const WORKFLOW_INTERACTION_SCHEMA_STATEMENTS: &[&str] = &[
    CREATE_WORKFLOW_INTERACTION_AUTHORITIES,
    CREATE_WORKFLOW_INTERACTIONS,
    CREATE_WORKFLOW_INTERACTION_EVENTS,
    CREATE_WORKFLOW_INTERACTION_DELIVERIES,
    CREATE_WORKFLOW_INTERACTION_IDEMPOTENCY,
    CREATE_WORKFLOW_INTERACTION_ACKNOWLEDGEMENTS,
    CREATE_WORKFLOW_INTERACTION_CURSORS,
];

const SEED_REVIEW_TARGET_LIFECYCLE: &str = r#"
INSERT INTO review_target_lifecycle (
    review_id,
    inactive_since_ms,
    observed_at_ms
)
SELECT
    review_id,
    created_at_ms,
    created_at_ms
FROM review_targets
WHERE 1
ON CONFLICT(review_id) DO NOTHING
"#;

#[cfg(test)]
pub(crate) const V1_SCHEMA_STATEMENTS: &[&str] = &[
    CREATE_METADATA,
    CREATE_PROJECTS,
    CREATE_WORKSPACES,
    CREATE_AGENTS,
    CREATE_SESSION_BINDINGS,
    CREATE_OPERATION_EVENTS,
];

#[cfg(test)]
pub(crate) const V2_SCHEMA_STATEMENTS: &[&str] = &[
    CREATE_METADATA,
    CREATE_PROJECTS,
    CREATE_WORKSPACES,
    CREATE_AGENTS,
    CREATE_SESSION_BINDINGS,
    CREATE_OPERATION_EVENTS,
    CREATE_OPERATION_RECEIPTS,
];

#[cfg(test)]
pub(crate) const V3_SCHEMA_STATEMENTS: &[&str] = &[
    CREATE_METADATA,
    CREATE_PROJECTS,
    CREATE_WORKSPACES,
    CREATE_AGENTS,
    CREATE_SESSION_BINDINGS,
    CREATE_OPERATION_EVENTS,
    CREATE_OPERATION_RECEIPTS,
    CREATE_REVIEW_TARGETS,
];

#[cfg(test)]
pub(crate) const V4_SCHEMA_STATEMENTS: &[&str] = &[
    CREATE_METADATA,
    CREATE_PROJECTS,
    CREATE_WORKSPACES,
    CREATE_AGENTS,
    CREATE_SESSION_BINDINGS,
    CREATE_OPERATION_EVENTS,
    CREATE_OPERATION_RECEIPTS,
    CREATE_REVIEW_TARGETS,
    CREATE_REVIEW_TARGET_LIFECYCLE,
];

#[cfg(test)]
pub(crate) const V5_SCHEMA_STATEMENTS: &[&str] = &[
    CREATE_METADATA,
    CREATE_PROJECTS,
    CREATE_WORKSPACES,
    CREATE_AGENTS,
    CREATE_SESSION_BINDINGS,
    CREATE_OPERATION_EVENTS,
    CREATE_OPERATION_RECEIPTS,
    CREATE_REVIEW_TARGETS,
    CREATE_REVIEW_TARGET_LIFECYCLE,
    CREATE_PLUGIN_APPLY_EVENTS,
    CREATE_PLUGIN_APPLY_RECEIPTS_V5_V6,
];

#[cfg(test)]
pub(crate) const V6_SCHEMA_STATEMENTS: &[&str] = &[
    CREATE_METADATA,
    CREATE_PROJECTS,
    CREATE_WORKSPACES,
    CREATE_AGENTS,
    CREATE_SESSION_BINDINGS,
    CREATE_OPERATION_EVENTS,
    CREATE_OPERATION_RECEIPTS,
    CREATE_REVIEW_TARGETS,
    CREATE_REVIEW_TARGET_LIFECYCLE,
    CREATE_PLUGIN_APPLY_EVENTS,
    CREATE_PLUGIN_APPLY_RECEIPTS_V5_V6,
    CREATE_PLUGIN_NATIVE_OWNERSHIP_EVENTS,
    CREATE_PLUGIN_NATIVE_OWNERSHIP,
];

#[cfg(test)]
pub(crate) const V7_SCHEMA_STATEMENTS: &[&str] = &[
    CREATE_METADATA,
    CREATE_PROJECTS,
    CREATE_WORKSPACES,
    CREATE_AGENTS,
    CREATE_SESSION_BINDINGS,
    CREATE_OPERATION_EVENTS,
    CREATE_OPERATION_RECEIPTS,
    CREATE_REVIEW_TARGETS,
    CREATE_REVIEW_TARGET_LIFECYCLE,
    CREATE_PLUGIN_APPLY_EVENTS,
    CREATE_PLUGIN_APPLY_RECEIPTS,
    CREATE_PLUGIN_NATIVE_OWNERSHIP_EVENTS,
    CREATE_PLUGIN_NATIVE_OWNERSHIP,
];

#[cfg(test)]
pub(crate) const V8_SCHEMA_STATEMENTS: &[&str] = &[
    CREATE_METADATA,
    CREATE_PROJECTS,
    CREATE_WORKSPACES,
    CREATE_AGENTS,
    CREATE_SESSION_BINDINGS,
    CREATE_OPERATION_EVENTS,
    CREATE_OPERATION_RECEIPTS,
    CREATE_REVIEW_TARGETS,
    CREATE_REVIEW_TARGET_LIFECYCLE,
    CREATE_PLUGIN_APPLY_EVENTS,
    CREATE_PLUGIN_APPLY_RECEIPTS,
    CREATE_PLUGIN_NATIVE_OWNERSHIP_EVENTS,
    CREATE_PLUGIN_NATIVE_OWNERSHIP,
    CREATE_AGENT_CHECKPOINTS,
    CREATE_AGENT_CHECKPOINT_RECEIPTS,
];

#[cfg(test)]
pub(crate) const V9_SCHEMA_STATEMENTS: &[&str] = &[
    CREATE_METADATA,
    CREATE_PROJECTS,
    CREATE_WORKSPACES,
    CREATE_AGENTS,
    CREATE_SESSION_BINDINGS,
    CREATE_OPERATION_EVENTS,
    CREATE_OPERATION_RECEIPTS,
    CREATE_REVIEW_TARGETS,
    CREATE_REVIEW_TARGET_LIFECYCLE,
    CREATE_PLUGIN_APPLY_EVENTS,
    CREATE_PLUGIN_APPLY_RECEIPTS,
    CREATE_PLUGIN_NATIVE_OWNERSHIP_EVENTS,
    CREATE_PLUGIN_NATIVE_OWNERSHIP,
    CREATE_AGENT_CHECKPOINTS,
    CREATE_AGENT_CHECKPOINT_RECEIPTS,
    CREATE_PLUGIN_NATIVE_TARGET_BINDINGS,
];

#[cfg(test)]
pub(crate) const V10_SCHEMA_STATEMENTS: &[&str] = &[
    CREATE_METADATA,
    CREATE_PROJECTS,
    CREATE_WORKSPACES,
    CREATE_AGENTS,
    CREATE_SESSION_BINDINGS,
    CREATE_OPERATION_EVENTS,
    CREATE_OPERATION_RECEIPTS,
    CREATE_REVIEW_TARGETS,
    CREATE_REVIEW_TARGET_LIFECYCLE,
    CREATE_PLUGIN_APPLY_EVENTS,
    CREATE_PLUGIN_APPLY_RECEIPTS,
    CREATE_PLUGIN_NATIVE_OWNERSHIP_EVENTS,
    CREATE_PLUGIN_NATIVE_OWNERSHIP,
    CREATE_AGENT_CHECKPOINTS,
    CREATE_AGENT_CHECKPOINT_RECEIPTS,
    CREATE_PLUGIN_NATIVE_TARGET_BINDINGS,
    CREATE_AGENT_CHECKPOINT_BINDING_AUTHORITIES,
];

#[cfg(test)]
pub(crate) const V11_SCHEMA_STATEMENTS: &[&str] = &[
    CREATE_METADATA,
    CREATE_PROJECTS,
    CREATE_WORKSPACES,
    CREATE_AGENTS,
    CREATE_SESSION_BINDINGS,
    CREATE_OPERATION_EVENTS,
    CREATE_OPERATION_RECEIPTS,
    CREATE_REVIEW_TARGETS,
    CREATE_REVIEW_TARGET_LIFECYCLE,
    CREATE_PLUGIN_APPLY_EVENTS,
    CREATE_PLUGIN_APPLY_RECEIPTS,
    CREATE_PLUGIN_NATIVE_OWNERSHIP_EVENTS,
    CREATE_PLUGIN_NATIVE_OWNERSHIP,
    CREATE_AGENT_CHECKPOINTS,
    CREATE_AGENT_CHECKPOINT_RECEIPTS,
    CREATE_PLUGIN_NATIVE_TARGET_BINDINGS,
    CREATE_AGENT_CHECKPOINT_BINDING_AUTHORITIES,
    CREATE_CLIENT_VIEW_AUTHORITIES,
    CREATE_CLIENT_VIEW_GENERATION_RECEIPTS,
    CREATE_CLIENT_VIEWS,
    CREATE_CLIENT_VIEW_WRITE_RECEIPTS,
];

#[cfg(test)]
pub(crate) const V12_SCHEMA_STATEMENTS: &[&str] = &[
    CREATE_METADATA,
    CREATE_PROJECTS,
    CREATE_WORKSPACES,
    CREATE_AGENTS,
    CREATE_SESSION_BINDINGS,
    CREATE_OPERATION_EVENTS,
    CREATE_OPERATION_RECEIPTS,
    CREATE_REVIEW_TARGETS,
    CREATE_REVIEW_TARGET_LIFECYCLE,
    CREATE_PLUGIN_APPLY_EVENTS,
    CREATE_PLUGIN_APPLY_RECEIPTS,
    CREATE_PLUGIN_NATIVE_OWNERSHIP_EVENTS,
    CREATE_PLUGIN_NATIVE_OWNERSHIP,
    CREATE_AGENT_CHECKPOINTS,
    CREATE_AGENT_CHECKPOINT_RECEIPTS,
    CREATE_PLUGIN_NATIVE_TARGET_BINDINGS,
    CREATE_AGENT_CHECKPOINT_BINDING_AUTHORITIES,
    CREATE_CLIENT_VIEW_AUTHORITIES,
    CREATE_CLIENT_VIEW_GENERATION_RECEIPTS,
    CREATE_CLIENT_VIEWS,
    CREATE_CLIENT_VIEW_WRITE_RECEIPTS,
    CREATE_AGENT_SPAWN_EVENTS_V12_TO_V31,
    CREATE_AGENT_SPAWN_RECEIPTS,
];

#[cfg(test)]
pub(crate) const V13_SCHEMA_STATEMENTS: &[&str] = &[
    CREATE_METADATA,
    CREATE_PROJECTS,
    CREATE_WORKSPACES,
    CREATE_AGENTS,
    CREATE_SESSION_BINDINGS,
    CREATE_OPERATION_EVENTS,
    CREATE_OPERATION_RECEIPTS,
    CREATE_REVIEW_TARGETS,
    CREATE_REVIEW_TARGET_LIFECYCLE,
    CREATE_PLUGIN_APPLY_EVENTS,
    CREATE_PLUGIN_APPLY_RECEIPTS,
    CREATE_PLUGIN_NATIVE_OWNERSHIP_EVENTS,
    CREATE_PLUGIN_NATIVE_OWNERSHIP,
    CREATE_AGENT_CHECKPOINTS,
    CREATE_AGENT_CHECKPOINT_RECEIPTS,
    CREATE_PLUGIN_NATIVE_TARGET_BINDINGS,
    CREATE_AGENT_CHECKPOINT_BINDING_AUTHORITIES,
    CREATE_CLIENT_VIEW_AUTHORITIES,
    CREATE_CLIENT_VIEW_GENERATION_RECEIPTS,
    CREATE_CLIENT_VIEWS,
    CREATE_CLIENT_VIEW_WRITE_RECEIPTS,
    CREATE_AGENT_SPAWN_EVENTS_V12_TO_V31,
    CREATE_AGENT_SPAWN_RECEIPTS,
    CREATE_WORKFLOW_RUNS,
    CREATE_WORKFLOW_TASKS,
    CREATE_WORKFLOW_DISPATCHES_V13_TO_V16,
    CREATE_WORKFLOW_DELEGATE_ONCE_RECEIPTS,
];

#[cfg(test)]
pub(crate) const V14_SCHEMA_STATEMENTS: &[&str] = &[
    CREATE_METADATA,
    CREATE_PROJECTS,
    CREATE_WORKSPACES,
    CREATE_AGENTS,
    CREATE_SESSION_BINDINGS,
    CREATE_OPERATION_EVENTS,
    CREATE_OPERATION_RECEIPTS,
    CREATE_REVIEW_TARGETS,
    CREATE_REVIEW_TARGET_LIFECYCLE,
    CREATE_PLUGIN_APPLY_EVENTS,
    CREATE_PLUGIN_APPLY_RECEIPTS,
    CREATE_PLUGIN_NATIVE_OWNERSHIP_EVENTS,
    CREATE_PLUGIN_NATIVE_OWNERSHIP,
    CREATE_AGENT_CHECKPOINTS,
    CREATE_AGENT_CHECKPOINT_RECEIPTS,
    CREATE_PLUGIN_NATIVE_TARGET_BINDINGS,
    CREATE_AGENT_CHECKPOINT_BINDING_AUTHORITIES,
    CREATE_CLIENT_VIEW_AUTHORITIES,
    CREATE_CLIENT_VIEW_GENERATION_RECEIPTS,
    CREATE_CLIENT_VIEWS,
    CREATE_CLIENT_VIEW_WRITE_RECEIPTS,
    CREATE_AGENT_SPAWN_EVENTS_V12_TO_V31,
    CREATE_AGENT_SPAWN_RECEIPTS,
    CREATE_WORKFLOW_RUNS,
    CREATE_WORKFLOW_TASKS,
    CREATE_WORKFLOW_DISPATCHES_V13_TO_V16,
    CREATE_WORKFLOW_DELEGATE_ONCE_RECEIPTS,
    CREATE_WORKFLOW_DISPATCH_LAUNCHES_V13,
];

const CURRENT_SCHEMA_STATEMENTS: &[&str] = &[
    crate::browser_profiles::CREATE_PROFILES,
    crate::browser_profiles::CREATE_DEFAULT,
    CREATE_METADATA,
    CREATE_PROJECTS,
    CREATE_WORKSPACES,
    CREATE_AGENTS,
    crate::agent_goals::CREATE_GOALS,
    crate::agent_goals::ACTIVE_GOALS,
    crate::agent_goals::CREATE_MUTATIONS,
    crate::agent_queue::CREATE_QUEUE,
    crate::agent_queue::QUEUED_ORDER,
    CREATE_SESSION_BINDINGS,
    crate::session_checkout::CREATE_BINDINGS,
    crate::agent_runtime_checkout::roots::CREATE_ROOTS,
    crate::agent_runtime_checkout::roots::ROOTS_BY_REGISTRATION,
    crate::agent_runtime_checkout::ADD_AGENT_CHECKOUT_OWNER,
    CREATE_AGENT_INTERACTION_SESSIONS,
    CREATE_AGENT_PROVIDER_STREAMS,
    CREATE_AGENT_TIMELINE_ROWS,
    CREATE_AGENT_TIMELINE_LIVE_TEXT,
    CREATE_AGENT_TIMELINE_SOURCE_RECEIPTS,
    CREATE_AGENT_PROVIDER_GAPS,
    CREATE_AGENT_PENDING_REQUESTS,
    CREATE_AGENT_PENDING_REQUESTS_CURRENT_INDEX,
    CREATE_AGENT_TURN_EFFECTS,
    CREATE_AGENT_PENDING_ANSWER_EFFECTS,
    CREATE_AGENT_RUNTIME_SELECTIONS,
    CREATE_AGENT_RUNTIME_NATIVE_REHOST_RECEIPTS,
    CREATE_AGENT_RUNTIME_TRANSITIONS,
    CREATE_AGENT_RUNTIME_TRANSITIONS_ACTIVE_INDEX,
    crate::agent_runtime_transition::request_replay::CREATE_REQUEST_RECEIPTS,
    CREATE_AGENT_RUNTIME_CLOSES,
    CREATE_AGENT_RUNTIME_CLOSES_ACTIVE_INDEX,
    CREATE_OPERATION_EVENTS,
    CREATE_OPERATION_RECEIPTS,
    CREATE_REVIEW_TARGETS,
    CREATE_REVIEW_TARGET_LIFECYCLE,
    CREATE_PLUGIN_APPLY_EVENTS,
    CREATE_PLUGIN_APPLY_RECEIPTS,
    CREATE_PLUGIN_NATIVE_OWNERSHIP_EVENTS,
    CREATE_PLUGIN_NATIVE_OWNERSHIP,
    CREATE_AGENT_CHECKPOINTS,
    CREATE_AGENT_CHECKPOINT_RECEIPTS,
    CREATE_PLUGIN_NATIVE_TARGET_BINDINGS,
    CREATE_AGENT_CHECKPOINT_BINDING_AUTHORITIES,
    CREATE_CLIENT_VIEW_AUTHORITIES,
    CREATE_CLIENT_VIEW_GENERATION_RECEIPTS,
    CREATE_CLIENT_VIEWS,
    CREATE_CLIENT_VIEW_WRITE_RECEIPTS,
    CREATE_AGENT_SPAWN_EVENTS,
    CREATE_AGENT_SPAWN_RECEIPTS,
    CREATE_AGENT_DISPATCH_STOPS,
    CREATE_AGENT_DISPATCH_STOPS_ACTIVE_AGENT_INDEX,
    CREATE_AGENT_DISPATCH_STOPS_ACTIVE_SPAWN_INDEX,
    CREATE_AGENT_DISPATCH_STOPS_SPAWN_HISTORY_INDEX,
    CREATE_AGENT_DISPATCH_STOPS_RECOVERY_INDEX,
    CREATE_PROVIDER_LAUNCH_DEFAULTS,
    CREATE_PROVIDER_LAUNCH_DEFAULTS_PUT_RECEIPTS,
    CREATE_PROVIDER_CREDENTIAL_PROFILES,
    crate::workflow_graph::execution_schema::RUNS,
    CREATE_WORKFLOW_TASKS,
    crate::workflow_graph::execution_schema::DISPATCHES,
    CREATE_WORKFLOW_DELEGATE_ONCE_RECEIPTS,
    CREATE_WORKFLOW_DISPATCH_LAUNCHES_V19_TO_V31,
    ADD_WORKFLOW_EFFECTIVE_LAUNCH_IDEMPOTENCY_KEY,
    CREATE_WORKFLOW_DISPATCH_LAUNCHES_ACTIVE_SESSION_INDEX,
    crate::workflow::launch::ADD_PREPARED_LAUNCH,
    CREATE_WORKFLOW_INTERACTION_AUTHORITIES,
    CREATE_WORKFLOW_INTERACTIONS,
    CREATE_WORKFLOW_INTERACTION_EVENTS,
    CREATE_WORKFLOW_INTERACTION_DELIVERIES,
    CREATE_WORKFLOW_INTERACTION_IDEMPOTENCY,
    CREATE_WORKFLOW_INTERACTION_ACKNOWLEDGEMENTS,
    CREATE_WORKFLOW_INTERACTION_CURSORS,
    CREATE_SCHEDULES,
    CREATE_SCHEDULE_MUTATION_RECEIPTS,
    CREATE_SCHEDULE_OCCURRENCES_V39,
    CREATE_SCHEDULE_OCCURRENCES_PENDING_INDEX_V39,
    crate::workflow_graph::schema::DEFINITIONS,
    crate::workflow_graph::schema::VERSIONS,
    crate::workflow_graph::schema::RECEIPTS,
    crate::workflow_graph::execution_schema::SOURCES,
    crate::workflow_graph::execution_schema::EFFECTS,
    crate::workflow_graph::execution_schema::EVENTS,
    crate::workflow_graph::execution_schema::ACTIVE_INDEX,
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MigrationMarker {
    from_version: u32,
    to_version: u32,
    backup_path: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Metadata {
    pub(crate) schema_info: StoreSchemaInfoV1,
    pub(crate) migration: Option<MigrationMarker>,
}

pub(crate) async fn open_database(
    path: &Path,
) -> Result<(SqlitePool, PathBuf, StoreSchemaInfoV1), DomainStoreErrorV1> {
    let path = absolute_database_path(path)?;
    validate_database_path(&path)?;
    inspect_existing_database(&path).await?;

    let pool = SqlitePoolOptions::new()
        .max_connections(MAX_CONNECTIONS)
        .connect_with(writable_connect_options(&path))
        .await
        .map_err(|error| map_sqlx("open", error))?;

    if let Err(error) = initialize_or_migrate(&pool, &path).await {
        pool.close().await;
        return Err(error);
    }

    let metadata = match read_pool_metadata(&pool).await {
        Ok(metadata) => metadata,
        Err(error) => {
            pool.close().await;
            return Err(error);
        }
    };
    if let Err(error) = metadata.schema_info.validate_for_current_host() {
        pool.close().await;
        return Err(error);
    }
    if let Some(marker) = metadata.migration {
        pool.close().await;
        return Err(interrupted_migration_error(&marker));
    }
    Ok((pool, path, metadata.schema_info))
}

pub(crate) async fn preflight_database(path: &Path) -> Result<(), DomainStoreErrorV1> {
    let path = absolute_database_path(path)?;
    validate_database_path(&path)?;
    let Some(metadata) = inspect_existing_database(&path).await? else {
        return Ok(());
    };
    if let Some(marker) = metadata.migration {
        return Err(interrupted_migration_error(&marker));
    }
    if !(1..=CURRENT_STORE_SCHEMA_VERSION).contains(&metadata.schema_info.schema_version) {
        return Err(DomainStoreErrorV1::Compatibility {
            code: "unsupported_migration_source",
            detail: format!(
                "no deterministic migration from schema {}",
                metadata.schema_info.schema_version
            ),
        });
    }
    Ok(())
}

async fn inspect_existing_database(path: &Path) -> Result<Option<Metadata>, DomainStoreErrorV1> {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) if metadata.len() > 0 => metadata,
        Ok(_) => return Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io("inspect_database", error)),
    };
    if !metadata.is_file() {
        return Err(storage(
            "invalid_database_path",
            "database path is not a regular file",
        ));
    }

    let options = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .create_if_missing(false)
        .foreign_keys(true)
        .busy_timeout(DEFAULT_BUSY_TIMEOUT);
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(|error| map_sqlx("compatibility_preflight", error))?;

    if !table_exists(&mut connection, "store_metadata").await? {
        if user_table_count(&mut connection).await? > 0 {
            return Err(DomainStoreErrorV1::Compatibility {
                code: "metadata_missing",
                detail: "non-empty SQLite database has no store_metadata table".into(),
            });
        }
        return Ok(None);
    }

    let metadata = read_metadata(&mut connection).await?;
    metadata.schema_info.validate_for_current_host()?;
    Ok(Some(metadata))
}

async fn initialize_or_migrate(pool: &SqlitePool, path: &Path) -> Result<(), DomainStoreErrorV1> {
    let mut metadata = initialize_if_empty(pool).await?;
    loop {
        metadata.schema_info.validate_for_current_host()?;
        match metadata.schema_info.schema_version {
            CURRENT_STORE_SCHEMA_VERSION => {
                if let Some(marker) = metadata.migration {
                    return Err(interrupted_migration_error(&marker));
                }
                return Ok(());
            }
            1 => {
                migrate_schema(
                    pool,
                    path,
                    metadata.migration,
                    1,
                    2,
                    &[CREATE_OPERATION_RECEIPTS],
                    "migrate_v1_to_v2",
                )
                .await?;
            }
            2 => {
                migrate_schema(
                    pool,
                    path,
                    metadata.migration,
                    2,
                    3,
                    &[CREATE_REVIEW_TARGETS],
                    "migrate_v2_to_v3",
                )
                .await?;
            }
            3 => {
                migrate_schema(
                    pool,
                    path,
                    metadata.migration,
                    3,
                    4,
                    &[CREATE_REVIEW_TARGET_LIFECYCLE, SEED_REVIEW_TARGET_LIFECYCLE],
                    "migrate_v3_to_v4",
                )
                .await?;
            }
            4 => {
                migrate_schema(
                    pool,
                    path,
                    metadata.migration,
                    4,
                    5,
                    &[
                        CREATE_PLUGIN_APPLY_EVENTS,
                        CREATE_PLUGIN_APPLY_RECEIPTS_V5_V6,
                    ],
                    "migrate_v4_to_v5",
                )
                .await?;
            }
            5 => {
                migrate_schema(
                    pool,
                    path,
                    metadata.migration,
                    5,
                    6,
                    &[
                        CREATE_PLUGIN_NATIVE_OWNERSHIP_EVENTS,
                        CREATE_PLUGIN_NATIVE_OWNERSHIP,
                    ],
                    "migrate_v5_to_v6",
                )
                .await?;
            }
            6 => {
                migrate_schema(
                    pool,
                    path,
                    metadata.migration,
                    6,
                    7,
                    &[
                        RENAME_PLUGIN_APPLY_RECEIPTS_V6,
                        CREATE_PLUGIN_APPLY_RECEIPTS,
                        COPY_PLUGIN_APPLY_RECEIPTS_V6,
                        DROP_PLUGIN_APPLY_RECEIPTS_V6,
                    ],
                    "migrate_v6_to_v7",
                )
                .await?;
            }
            7 => {
                migrate_schema(
                    pool,
                    path,
                    metadata.migration,
                    7,
                    8,
                    &[CREATE_AGENT_CHECKPOINTS, CREATE_AGENT_CHECKPOINT_RECEIPTS],
                    "migrate_v7_to_v8",
                )
                .await?;
            }
            8 => {
                migrate_schema(
                    pool,
                    path,
                    metadata.migration,
                    8,
                    9,
                    &[
                        CREATE_AGENT_CHECKPOINTS,
                        CREATE_AGENT_CHECKPOINT_RECEIPTS,
                        CREATE_PLUGIN_NATIVE_TARGET_BINDINGS,
                    ],
                    "migrate_v8_to_v9",
                )
                .await?;
            }
            9 => {
                migrate_schema(
                    pool,
                    path,
                    metadata.migration,
                    9,
                    10,
                    &[CREATE_AGENT_CHECKPOINT_BINDING_AUTHORITIES],
                    "migrate_v9_to_v10",
                )
                .await?;
            }
            10 => {
                migrate_schema(
                    pool,
                    path,
                    metadata.migration,
                    10,
                    11,
                    &[
                        CREATE_CLIENT_VIEW_AUTHORITIES,
                        CREATE_CLIENT_VIEW_GENERATION_RECEIPTS,
                        CREATE_CLIENT_VIEWS,
                        CREATE_CLIENT_VIEW_WRITE_RECEIPTS,
                    ],
                    "migrate_v10_to_v11",
                )
                .await?;
            }
            11 => {
                migrate_schema(
                    pool,
                    path,
                    metadata.migration,
                    11,
                    12,
                    &[
                        CREATE_AGENT_SPAWN_EVENTS_V12_TO_V31,
                        CREATE_AGENT_SPAWN_RECEIPTS,
                    ],
                    "migrate_v11_to_v12",
                )
                .await?;
            }
            12 => {
                migrate_schema(
                    pool,
                    path,
                    metadata.migration,
                    12,
                    13,
                    &[
                        CREATE_WORKFLOW_RUNS,
                        CREATE_WORKFLOW_TASKS,
                        CREATE_WORKFLOW_DISPATCHES_V13_TO_V16,
                        CREATE_WORKFLOW_DELEGATE_ONCE_RECEIPTS,
                    ],
                    "migrate_v12_to_v13",
                )
                .await?;
            }
            13 => {
                migrate_schema(
                    pool,
                    path,
                    metadata.migration,
                    13,
                    14,
                    &[
                        CREATE_WORKFLOW_DISPATCH_LAUNCHES_V13,
                        SEED_WORKFLOW_DISPATCH_LAUNCHES,
                    ],
                    "migrate_v13_to_v14",
                )
                .await?;
            }
            14 => {
                migrate_schema(
                    pool,
                    path,
                    metadata.migration,
                    14,
                    15,
                    &[
                        RENAME_WORKFLOW_DISPATCH_LAUNCHES_V13,
                        CREATE_WORKFLOW_DISPATCH_LAUNCHES_V15_TO_V18,
                        COPY_WORKFLOW_DISPATCH_LAUNCHES_V13,
                        DROP_WORKFLOW_DISPATCH_LAUNCHES_V13,
                    ],
                    "migrate_v14_to_v15",
                )
                .await?;
            }
            15 => {
                migrate_schema(
                    pool,
                    path,
                    metadata.migration,
                    15,
                    16,
                    &[],
                    "migrate_v15_to_v16",
                )
                .await?;
            }
            16 => {
                migrate_schema(
                    pool,
                    path,
                    metadata.migration,
                    16,
                    17,
                    &[ADD_WORKFLOW_COMPLETION_RESULT],
                    "migrate_v16_to_v17",
                )
                .await?;
            }
            17 => {
                migrate_schema(
                    pool,
                    path,
                    metadata.migration,
                    17,
                    18,
                    WORKFLOW_INTERACTION_SCHEMA_STATEMENTS,
                    "migrate_v17_to_v18",
                )
                .await?;
            }
            18 => {
                migrate_schema(
                    pool,
                    path,
                    metadata.migration,
                    18,
                    19,
                    &[
                        RENAME_WORKFLOW_DISPATCH_LAUNCHES_V18,
                        CREATE_WORKFLOW_DISPATCH_LAUNCHES_V19_TO_V31,
                        COPY_WORKFLOW_DISPATCH_LAUNCHES_V18,
                        DROP_WORKFLOW_DISPATCH_LAUNCHES_V18,
                    ],
                    "migrate_v18_to_v19",
                )
                .await?;
            }
            19 => {
                migrate_schema(
                    pool,
                    path,
                    metadata.migration,
                    19,
                    20,
                    &[
                        CREATE_SCHEDULES,
                        CREATE_SCHEDULE_MUTATION_RECEIPTS,
                        CREATE_SCHEDULE_OCCURRENCES,
                    ],
                    "migrate_v19_to_v20",
                )
                .await?;
            }
            20 => {
                let mut statements = Vec::with_capacity(4);
                if !table_column_exists(pool, "schedules", "admitted_through_ms").await? {
                    statements.push(ADD_SCHEDULE_ADMISSION_WATERMARK);
                }
                statements.extend([
                    BACKFILL_SCHEDULE_ADMISSION_WATERMARK,
                    COMPACT_SCHEDULE_OCCURRENCES_V20,
                    CREATE_SCHEDULE_OCCURRENCES_PENDING_INDEX,
                ]);
                migrate_schema(
                    pool,
                    path,
                    metadata.migration,
                    20,
                    21,
                    &statements,
                    "migrate_v20_to_v21",
                )
                .await?;
            }
            21 => {
                migrate_schema(
                    pool,
                    path,
                    metadata.migration,
                    21,
                    22,
                    &[
                        CREATE_PROVIDER_LAUNCH_DEFAULTS,
                        CREATE_PROVIDER_LAUNCH_DEFAULTS_PUT_RECEIPTS,
                    ],
                    "migrate_v21_to_v22",
                )
                .await?;
            }
            22 => {
                migrate_schema(
                    pool,
                    path,
                    metadata.migration,
                    22,
                    23,
                    &[
                        CREATE_AGENT_INTERACTION_SESSIONS,
                        CREATE_AGENT_PROVIDER_STREAMS,
                        CREATE_AGENT_TIMELINE_ROWS,
                        CREATE_AGENT_TIMELINE_LIVE_TEXT,
                        CREATE_AGENT_TIMELINE_SOURCE_RECEIPTS,
                        CREATE_AGENT_PROVIDER_GAPS,
                        CREATE_AGENT_PENDING_REQUESTS,
                        CREATE_AGENT_PENDING_REQUESTS_CURRENT_INDEX,
                        CREATE_AGENT_TURN_EFFECTS,
                        CREATE_AGENT_PENDING_ANSWER_EFFECTS_V23_TO_V27,
                    ],
                    "migrate_v22_to_v23",
                )
                .await?;
            }
            23 => {
                migrate_schema(
                    pool,
                    path,
                    metadata.migration,
                    23,
                    24,
                    &[CREATE_PROVIDER_CREDENTIAL_PROFILES],
                    "migrate_v23_to_v24",
                )
                .await?;
            }
            24 => {
                migrate_schema(
                    pool,
                    path,
                    metadata.migration,
                    24,
                    25,
                    &[NORMALIZE_LEGACY_AGENT_PROVIDER_IDS],
                    "migrate_v24_to_v25",
                )
                .await?;
            }
            25 => {
                migrate_schema(
                    pool,
                    path,
                    metadata.migration,
                    25,
                    26,
                    &[
                        CREATE_AGENT_RUNTIME_SELECTIONS,
                        CREATE_AGENT_RUNTIME_TRANSITIONS,
                        CREATE_AGENT_RUNTIME_TRANSITIONS_ACTIVE_INDEX,
                    ],
                    "migrate_v25_to_v26",
                )
                .await?;
            }
            26 => {
                migrate_schema(
                    pool,
                    path,
                    metadata.migration,
                    26,
                    27,
                    &[
                        CREATE_AGENT_RUNTIME_CLOSES,
                        CREATE_AGENT_RUNTIME_CLOSES_ACTIVE_INDEX,
                    ],
                    "migrate_v26_to_v27",
                )
                .await?;
            }
            27 => {
                migrate_schema(
                    pool,
                    path,
                    metadata.migration,
                    27,
                    28,
                    &[
                        RENAME_AGENT_PENDING_ANSWER_EFFECTS_V27,
                        CREATE_AGENT_PENDING_ANSWER_EFFECTS,
                        COPY_AGENT_PENDING_ANSWER_EFFECTS_V27,
                        DROP_AGENT_PENDING_ANSWER_EFFECTS_V27,
                    ],
                    "migrate_v27_to_v28",
                )
                .await?;
            }
            28 => {
                migrate_schema(
                    pool,
                    path,
                    metadata.migration,
                    28,
                    29,
                    &[
                        DROP_AGENT_RUNTIME_TRANSITIONS_ACTIVE_INDEX_V28,
                        DROP_AGENT_RUNTIME_CLOSES_ACTIVE_INDEX,
                        RENAME_AGENT_RUNTIME_TRANSITIONS_V28,
                        RENAME_AGENT_RUNTIME_CLOSES_V28,
                        CREATE_AGENT_RUNTIME_TRANSITIONS,
                        CREATE_AGENT_RUNTIME_CLOSES,
                        COPY_AGENT_RUNTIME_TRANSITIONS_V28,
                        COPY_AGENT_RUNTIME_CLOSES_V28,
                        DROP_AGENT_RUNTIME_TRANSITIONS_V28,
                        DROP_AGENT_RUNTIME_CLOSES_V28,
                        CREATE_AGENT_RUNTIME_TRANSITIONS_ACTIVE_INDEX,
                        CREATE_AGENT_RUNTIME_CLOSES_ACTIVE_INDEX,
                    ],
                    "migrate_v28_to_v29",
                )
                .await?;
            }
            29 => {
                migrate_schema(
                    pool,
                    path,
                    metadata.migration,
                    29,
                    30,
                    &[
                        DROP_AGENT_RUNTIME_TRANSITIONS_ACTIVE_INDEX_V29,
                        RENAME_AGENT_RUNTIME_TRANSITIONS_V29,
                        CREATE_AGENT_RUNTIME_TRANSITIONS,
                        COPY_AGENT_RUNTIME_TRANSITIONS_V29,
                        DROP_AGENT_RUNTIME_TRANSITIONS_V29,
                        CREATE_AGENT_RUNTIME_TRANSITIONS_ACTIVE_INDEX,
                    ],
                    "migrate_v29_to_v30",
                )
                .await?;
            }
            30 => {
                migrate_schema(
                    pool,
                    path,
                    metadata.migration,
                    30,
                    31,
                    &[CREATE_AGENT_RUNTIME_NATIVE_REHOST_RECEIPTS],
                    "migrate_v30_to_v31",
                )
                .await?;
            }
            31 => {
                migrate_schema(
                    pool,
                    path,
                    metadata.migration,
                    31,
                    32,
                    &[
                        RENAME_AGENT_SPAWN_EVENTS_V31,
                        CREATE_AGENT_SPAWN_EVENTS,
                        COPY_AGENT_SPAWN_EVENTS_V31,
                        DROP_AGENT_SPAWN_EVENTS_V31,
                    ],
                    "migrate_v31_to_v32",
                )
                .await?;
            }
            32 => {
                let mut statements = vec![
                    CREATE_AGENT_DISPATCH_STOPS_V33,
                    CREATE_AGENT_DISPATCH_STOPS_ACTIVE_AGENT_INDEX,
                    CREATE_AGENT_DISPATCH_STOPS_ACTIVE_SPAWN_INDEX,
                    CREATE_AGENT_DISPATCH_STOPS_SPAWN_HISTORY_INDEX,
                    CREATE_AGENT_DISPATCH_STOPS_RECOVERY_INDEX,
                ];
                if !table_column_exists(
                    pool,
                    "workflow_dispatch_launches",
                    "effective_launch_idempotency_key",
                )
                .await?
                {
                    statements.push(ADD_WORKFLOW_EFFECTIVE_LAUNCH_IDEMPOTENCY_KEY);
                }
                statements.push(BACKFILL_WORKFLOW_EFFECTIVE_LAUNCH_IDEMPOTENCY_KEY);
                migrate_schema(
                    pool,
                    path,
                    metadata.migration,
                    32,
                    33,
                    &statements,
                    "migrate_v32_to_v33",
                )
                .await?;
            }
            33 => {
                let mut statements = vec![
                    CREATE_AGENT_DISPATCH_STOPS_V33,
                    DROP_AGENT_DISPATCH_STOPS_ACTIVE_AGENT_INDEX_V33,
                    DROP_AGENT_DISPATCH_STOPS_ACTIVE_SPAWN_INDEX_V33,
                    DROP_AGENT_DISPATCH_STOPS_SPAWN_HISTORY_INDEX_V33,
                    DROP_AGENT_DISPATCH_STOPS_RECOVERY_INDEX_V33,
                    RENAME_AGENT_DISPATCH_STOPS_V33,
                    CREATE_AGENT_DISPATCH_STOPS_V34,
                    COPY_AGENT_DISPATCH_STOPS_V33,
                    DROP_AGENT_DISPATCH_STOPS_V33,
                    CREATE_AGENT_DISPATCH_STOPS_ACTIVE_AGENT_INDEX,
                    CREATE_AGENT_DISPATCH_STOPS_ACTIVE_SPAWN_INDEX,
                    CREATE_AGENT_DISPATCH_STOPS_SPAWN_HISTORY_INDEX,
                    CREATE_AGENT_DISPATCH_STOPS_RECOVERY_INDEX,
                ];
                if !table_column_exists(
                    pool,
                    "workflow_dispatch_launches",
                    "effective_launch_idempotency_key",
                )
                .await?
                {
                    statements.extend([
                        ADD_WORKFLOW_EFFECTIVE_LAUNCH_IDEMPOTENCY_KEY,
                        BACKFILL_WORKFLOW_EFFECTIVE_LAUNCH_IDEMPOTENCY_KEY,
                    ]);
                }
                migrate_schema(
                    pool,
                    path,
                    metadata.migration,
                    33,
                    34,
                    &statements,
                    "migrate_v33_to_v34",
                )
                .await?;
            }
            34 => {
                migrate_schema(
                    pool,
                    path,
                    metadata.migration,
                    34,
                    35,
                    &[
                        DROP_AGENT_DISPATCH_STOPS_ACTIVE_AGENT_INDEX_V34,
                        DROP_AGENT_DISPATCH_STOPS_ACTIVE_SPAWN_INDEX_V34,
                        DROP_AGENT_DISPATCH_STOPS_SPAWN_HISTORY_INDEX_V34,
                        DROP_AGENT_DISPATCH_STOPS_RECOVERY_INDEX_V34,
                        RENAME_AGENT_DISPATCH_STOPS_V34,
                        CREATE_AGENT_DISPATCH_STOPS,
                        COPY_AGENT_DISPATCH_STOPS_V34,
                        DROP_AGENT_DISPATCH_STOPS_V34,
                        CREATE_AGENT_DISPATCH_STOPS_ACTIVE_AGENT_INDEX,
                        CREATE_AGENT_DISPATCH_STOPS_ACTIVE_SPAWN_INDEX,
                        CREATE_AGENT_DISPATCH_STOPS_SPAWN_HISTORY_INDEX,
                        CREATE_AGENT_DISPATCH_STOPS_RECOVERY_INDEX,
                    ],
                    "migrate_v34_to_v35",
                )
                .await?;
            }
            35 => {
                let mut statements = Vec::new();
                if !table_column_exists(
                    pool,
                    "workflow_dispatch_launches",
                    "effective_launch_idempotency_key",
                )
                .await?
                {
                    statements.push(ADD_WORKFLOW_EFFECTIVE_LAUNCH_IDEMPOTENCY_KEY);
                }
                statements.push(BACKFILL_WORKFLOW_EFFECTIVE_LAUNCH_IDEMPOTENCY_KEY);
                migrate_schema(
                    pool,
                    path,
                    metadata.migration,
                    35,
                    36,
                    &statements,
                    "migrate_v35_to_v36",
                )
                .await?;
            }
            36 => {
                migrate_schema(
                    pool,
                    path,
                    metadata.migration,
                    36,
                    37,
                    &[CREATE_WORKFLOW_DISPATCH_LAUNCHES_ACTIVE_SESSION_INDEX],
                    "migrate_v36_to_v37",
                )
                .await?;
            }
            37 => {
                migrate_schema(
                    pool,
                    path,
                    metadata.migration,
                    37,
                    38,
                    &[
                        DROP_AGENT_RUNTIME_CLOSES_ACTIVE_INDEX,
                        CREATE_AGENT_RUNTIME_CLOSES_ACTIVE_INDEX,
                    ],
                    "migrate_v37_to_v38",
                )
                .await?;
            }
            38 => {
                migrate_schema(
                    pool,
                    path,
                    metadata.migration,
                    38,
                    39,
                    SCHEDULE_OCCURRENCES_V39_MIGRATION,
                    "migrate_v38_to_v39",
                )
                .await?;
            }
            39 => {
                migrate_schema(
                    pool,
                    path,
                    metadata.migration,
                    39,
                    40,
                    crate::agent_runtime_transition::request_replay::MIGRATE_REQUEST_RECEIPTS,
                    "migrate_v39_to_v40",
                )
                .await?;
            }
            40 => {
                migration::migrate_graph_schema(pool, path, metadata.migration).await?;
            }
            41 => {
                migration::migrate_checkout_binding_schema(pool, path, metadata.migration).await?;
            }
            42 => {
                migration::migrate_browser_profile_schema(pool, path, metadata.migration).await?;
            }
            43 => {
                let statements = if table_column_exists(
                    pool,
                    "workflow_dispatch_launches",
                    "prepared_launch_json",
                )
                .await?
                {
                    Vec::new()
                } else {
                    vec![crate::workflow::launch::ADD_PREPARED_LAUNCH]
                };
                migrate_schema(
                    pool,
                    path,
                    metadata.migration,
                    43,
                    44,
                    &statements,
                    "migrate_v43_to_v44",
                )
                .await?;
            }
            44 => {
                let mut statements = if table_column_exists(pool, "agent_runtime_selections", "checkout_owner_id").await? {
                    Vec::new()
                } else {
                    vec![crate::agent_runtime_checkout::ADD_CHECKOUT_OWNER]
                };
                if !table_column_exists(pool, "agent_runtime_closes", "removal_json").await? {
                    statements.push("ALTER TABLE agent_runtime_closes ADD COLUMN removal_json TEXT");
                }
                migrate_schema(pool, path, metadata.migration, 44, 45, &statements, "migrate_v44_to_v45").await?;
            }
            45 => {
                migration::migrate_agent_checkout_schema(pool, path, metadata.migration).await?;
            }
            46 => {
                migrate_schema(
                    pool,
                    path,
                    metadata.migration,
                    46,
                    47,
                    &[
                        crate::agent_runtime_checkout::roots::CREATE_ROOTS,
                        crate::agent_runtime_checkout::roots::ROOTS_BY_REGISTRATION,
                    ],
                    "migrate_v46_to_v47",
                )
                .await?;
            }
            47 => {
                migrate_schema(pool, path, metadata.migration, 47, 48, &[
                    crate::agent_goals::CREATE_GOALS,
                    crate::agent_goals::ACTIVE_GOALS,
                    crate::agent_goals::CREATE_MUTATIONS,
                ], "migrate_v47_to_v48").await?;
            }
            48 => {
                migrate_schema(pool, path, metadata.migration, 48, 49, &[
                    crate::agent_queue::CREATE_QUEUE,
                    crate::agent_queue::QUEUED_ORDER,
                ], "migrate_v48_to_v49").await?;
            }
            version => {
                return Err(DomainStoreErrorV1::Compatibility {
                    code: "unsupported_migration_source",
                    detail: format!("no deterministic migration from schema {version}"),
                });
            }
        }
        metadata = read_pool_metadata(pool).await?;
    }
}

async fn initialize_if_empty(pool: &SqlitePool) -> Result<Metadata, DomainStoreErrorV1> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("initialize", error))?;
    begin_immediate(&mut connection, "initialize").await?;

    let result = async {
        if table_exists(&mut connection, "store_metadata").await? {
            return read_metadata(&mut connection).await;
        }
        if user_table_count(&mut connection).await? > 0 {
            return Err(DomainStoreErrorV1::Compatibility {
                code: "metadata_missing",
                detail: "non-empty SQLite database has no store_metadata table".into(),
            });
        }

        execute_statements(&mut connection, CURRENT_SCHEMA_STATEMENTS, "initialize").await?;
        let current = StoreSchemaInfoV1::current();
        sqlx::query(
            r#"
            INSERT INTO store_metadata (
                singleton, schema_version, min_reader_version, min_writer_version
            ) VALUES (1, ?1, ?2, ?3)
            "#,
        )
        .bind(i64::from(current.schema_version))
        .bind(i64::from(current.min_reader_version))
        .bind(i64::from(current.min_writer_version))
        .execute(&mut *connection)
        .await
        .map_err(|error| map_sqlx("initialize", error))?;
        Ok(Metadata {
            schema_info: current,
            migration: None,
        })
    }
    .await;

    finish_transaction(&mut connection, "initialize", result).await
}

async fn record_migration_marker(
    pool: &SqlitePool,
    backup_path: &Path,
    from_version: u32,
    to_version: u32,
) -> Result<MigrationMarker, DomainStoreErrorV1> {
    let backup_text = backup_path_to_text(backup_path)?;
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("record_migration_marker", error))?;
    begin_immediate(&mut connection, "record_migration_marker").await?;

    let result = async {
        let metadata = read_metadata(&mut connection).await?;
        if migration_step_is_already_complete(&metadata, to_version) {
            return Ok(MigrationMarker {
                from_version,
                to_version,
                backup_path: backup_path.to_path_buf(),
            });
        }
        if let Some(marker) = metadata.migration {
            return Ok(marker);
        }
        if metadata.schema_info.schema_version != from_version {
            return Err(DomainStoreErrorV1::Compatibility {
                code: "migration_source_changed",
                detail: format!(
                    "expected schema {from_version} before migration, found {}",
                    metadata.schema_info.schema_version
                ),
            });
        }

        sqlx::query(
            r#"
            UPDATE store_metadata SET
                migration_from_version = ?1,
                migration_to_version = ?2,
                migration_backup_path = ?3
            WHERE singleton = 1
              AND schema_version = ?1
              AND migration_from_version IS NULL
            "#,
        )
        .bind(i64::from(from_version))
        .bind(i64::from(to_version))
        .bind(backup_text)
        .execute(&mut *connection)
        .await
        .map_err(|error| map_sqlx("record_migration_marker", error))?;

        Ok(MigrationMarker {
            from_version,
            to_version,
            backup_path: backup_path.to_path_buf(),
        })
    }
    .await;

    finish_transaction(&mut connection, "record_migration_marker", result).await
}

fn migration_step_is_already_complete(metadata: &Metadata, to_version: u32) -> bool {
    metadata.schema_info.schema_version >= to_version
        && metadata
            .migration
            .as_ref()
            .is_none_or(|marker| marker.from_version >= to_version)
}

async fn create_migration_backup(
    pool: &SqlitePool,
    path: &Path,
    from_version: u32,
    to_version: u32,
) -> Result<PathBuf, DomainStoreErrorV1> {
    let backup_path = available_backup_path(path, from_version, to_version)?;
    let backup_text = backup_path_to_text(&backup_path)?;
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("migration_backup", error))?;

    sqlx::query("VACUUM INTO ?1")
        .bind(backup_text)
        .execute(&mut *connection)
        .await
        .map_err(|error| map_sqlx("migration_backup", error))?;

    if !is_recoverable_backup(&backup_path) {
        return Err(storage(
            "migration_backup_invalid",
            "SQLite did not produce a non-empty backup file",
        ));
    }
    Ok(backup_path)
}

async fn read_pool_metadata(pool: &SqlitePool) -> Result<Metadata, DomainStoreErrorV1> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("read_metadata", error))?;
    read_metadata(&mut connection).await
}

pub(crate) async fn read_metadata(
    connection: &mut SqliteConnection,
) -> Result<Metadata, DomainStoreErrorV1> {
    let row = sqlx::query(
        r#"
        SELECT
            schema_version,
            min_reader_version,
            min_writer_version,
            migration_from_version,
            migration_to_version,
            migration_backup_path
        FROM store_metadata
        WHERE singleton = 1
        "#,
    )
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_metadata", error))?
    .ok_or_else(|| DomainStoreErrorV1::Compatibility {
        code: "metadata_row_missing",
        detail: "store_metadata has no singleton row".into(),
    })?;

    let schema_version = metadata_u32(&row, "schema_version")?;
    let min_reader_version = metadata_u32(&row, "min_reader_version")?;
    let min_writer_version = metadata_u32(&row, "min_writer_version")?;
    let migration_from = row
        .try_get::<Option<i64>, _>("migration_from_version")
        .map_err(|error| crate::error::corrupt_row("store_metadata", error))?;
    let migration_to = row
        .try_get::<Option<i64>, _>("migration_to_version")
        .map_err(|error| crate::error::corrupt_row("store_metadata", error))?;
    let backup_path = row
        .try_get::<Option<String>, _>("migration_backup_path")
        .map_err(|error| crate::error::corrupt_row("store_metadata", error))?;

    let migration = match (migration_from, migration_to, backup_path) {
        (None, None, None) => None,
        (Some(from), Some(to), Some(path)) => Some(MigrationMarker {
            from_version: positive_u32(from, "migration_from_version")?,
            to_version: positive_u32(to, "migration_to_version")?,
            backup_path: PathBuf::from(path),
        }),
        _ => {
            return Err(DomainStoreErrorV1::Compatibility {
                code: "partial_migration_marker",
                detail: "migration metadata must be either wholly present or wholly absent".into(),
            });
        }
    };

    Ok(Metadata {
        schema_info: StoreSchemaInfoV1 {
            schema_version,
            min_reader_version,
            min_writer_version,
        },
        migration,
    })
}

pub(crate) async fn execute_statements(
    connection: &mut SqliteConnection,
    statements: &[&str],
    operation: &'static str,
) -> Result<(), DomainStoreErrorV1> {
    for statement in statements {
        sqlx::query(statement)
            .execute(&mut *connection)
            .await
            .map_err(|error| map_sqlx(operation, error))?;
    }
    Ok(())
}

#[cfg(test)]
pub(crate) async fn downgrade_workflow_launch_fixture_to_v31<'e, E>(
    executor: E,
) -> Result<(), sqlx::Error>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    sqlx::query(
        "ALTER TABLE workflow_dispatch_launches DROP COLUMN effective_launch_idempotency_key",
    )
    .execute(executor)
    .await?;
    Ok(())
}

async fn table_exists(
    connection: &mut SqliteConnection,
    table_name: &str,
) -> Result<bool, DomainStoreErrorV1> {
    let count = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT COUNT(*)
        FROM sqlite_schema
        WHERE type = 'table' AND name = ?1
        "#,
    )
    .bind(table_name)
    .fetch_one(&mut *connection)
    .await
    .map_err(|error| map_sqlx("inspect_schema", error))?;
    Ok(count > 0)
}

async fn table_column_exists(
    pool: &SqlitePool,
    table_name: &str,
    column_name: &str,
) -> Result<bool, DomainStoreErrorV1> {
    let count =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name = ?2")
            .bind(table_name)
            .bind(column_name)
            .fetch_one(pool)
            .await
            .map_err(|error| map_sqlx("inspect_table_schema", error))?;
    Ok(count == 1)
}

async fn user_table_count(connection: &mut SqliteConnection) -> Result<i64, DomainStoreErrorV1> {
    sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM sqlite_schema
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        "#,
    )
    .fetch_one(&mut *connection)
    .await
    .map_err(|error| map_sqlx("inspect_schema", error))
}

pub(crate) async fn begin_immediate(
    connection: &mut SqliteConnection,
    operation: &'static str,
) -> Result<(), DomainStoreErrorV1> {
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *connection)
        .await
        .map_err(|error| map_sqlx(operation, error))?;
    Ok(())
}

pub(crate) async fn finish_transaction<T>(
    connection: &mut SqliteConnection,
    operation: &'static str,
    result: Result<T, DomainStoreErrorV1>,
) -> Result<T, DomainStoreErrorV1> {
    match result {
        Ok(value) => {
            sqlx::query("COMMIT")
                .execute(&mut *connection)
                .await
                .map_err(|error| map_sqlx(operation, error))?;
            Ok(value)
        }
        Err(error) => {
            if let Err(rollback_error) = sqlx::query("ROLLBACK").execute(&mut *connection).await {
                return Err(storage(
                    "rollback_failed",
                    format!("{error}; rollback also failed: {rollback_error}"),
                ));
            }
            Err(error)
        }
    }
}

pub(crate) fn writable_connect_options(path: &Path) -> SqliteConnectOptions {
    SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(true)
        .busy_timeout(DEFAULT_BUSY_TIMEOUT)
}

fn absolute_database_path(path: &Path) -> Result<PathBuf, DomainStoreErrorV1> {
    if path.as_os_str().is_empty() {
        return Err(storage(
            "invalid_database_path",
            "database path must not be empty",
        ));
    }
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        std::env::current_dir()
            .map(|current| current.join(path))
            .map_err(|error| io("resolve_database_path", error))
    }
}

fn validate_database_path(path: &Path) -> Result<(), DomainStoreErrorV1> {
    let parent = path.parent().ok_or_else(|| {
        storage(
            "invalid_database_path",
            "database path must have a parent directory",
        )
    })?;
    if !parent.is_dir() {
        return Err(storage(
            "invalid_database_path",
            "database parent directory does not exist",
        ));
    }
    if path.file_name().is_none() {
        return Err(storage(
            "invalid_database_path",
            "database path must name a file",
        ));
    }
    Ok(())
}

fn available_backup_path(
    database_path: &Path,
    from_version: u32,
    to_version: u32,
) -> Result<PathBuf, DomainStoreErrorV1> {
    let parent = database_path.parent().ok_or_else(|| {
        storage(
            "invalid_database_path",
            "database path must have a parent directory",
        )
    })?;
    let file_name = database_path
        .file_name()
        .ok_or_else(|| storage("invalid_database_path", "database path must name a file"))?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| storage("clock_before_epoch", error.to_string()))?
        .as_millis();
    let sequence = BACKUP_SEQUENCE.fetch_add(1, Ordering::Relaxed);

    for attempt in 0..100_u32 {
        let mut candidate_name = OsString::from(file_name);
        candidate_name.push(format!(
            ".schema-{from_version}-to-{to_version}.{timestamp}.{}.{sequence}.{attempt}.bak",
            std::process::id(),
        ));
        let candidate = parent.join(candidate_name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(storage(
        "backup_name_exhausted",
        "could not allocate a unique migration backup name",
    ))
}

fn backup_path_to_text(path: &Path) -> Result<&str, DomainStoreErrorV1> {
    path.to_str().ok_or_else(|| {
        storage(
            "non_utf8_backup_path",
            "SQLite migration backup path must be valid UTF-8",
        )
    })
}

pub(crate) fn is_recoverable_backup(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0)
}

fn validate_migration_marker(
    marker: &MigrationMarker,
    from_version: u32,
    to_version: u32,
) -> Result<(), DomainStoreErrorV1> {
    if marker.from_version != from_version || marker.to_version != to_version {
        return Err(interrupted_migration_error(marker));
    }
    Ok(())
}

fn interrupted_migration_error(marker: &MigrationMarker) -> DomainStoreErrorV1 {
    DomainStoreErrorV1::InterruptedMigration {
        from_version: marker.from_version,
        to_version: marker.to_version,
        backup_name: marker.backup_path.display().to_string(),
    }
}

fn metadata_u32(row: &SqliteRow, column: &'static str) -> Result<u32, DomainStoreErrorV1> {
    let value = row
        .try_get::<i64, _>(column)
        .map_err(|error| crate::error::corrupt_row("store_metadata", error))?;
    positive_u32(value, column)
}

fn positive_u32(value: i64, field: &'static str) -> Result<u32, DomainStoreErrorV1> {
    u32::try_from(value)
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| {
            storage(
                "corrupt_metadata",
                format!("{field} must be a positive 32-bit integer"),
            )
        })
}
