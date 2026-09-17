pub(crate) const CREATE_SCHEDULES: &str = r#"
CREATE TABLE IF NOT EXISTS schedules (
    schedule_id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    revision INTEGER NOT NULL CHECK (revision > 0),
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    expression TEXT NOT NULL,
    timezone TEXT NOT NULL,
    run_template_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    deleted_at_ms INTEGER CHECK (deleted_at_ms >= updated_at_ms),
    admitted_through_ms INTEGER CHECK (
        admitted_through_ms IS NULL
        OR (admitted_through_ms >= 0 AND admitted_through_ms % 60000 = 0)
    )
)
"#;

pub(crate) const CREATE_SCHEDULE_MUTATION_RECEIPTS: &str = r#"
CREATE TABLE IF NOT EXISTS schedule_mutation_receipts (
    idempotency_key TEXT PRIMARY KEY,
    request_digest TEXT NOT NULL,
    mutation_kind TEXT NOT NULL CHECK (mutation_kind IN ('put', 'delete')),
    schedule_id TEXT NOT NULL,
    result_json TEXT NOT NULL,
    recorded_at_ms INTEGER NOT NULL CHECK (recorded_at_ms >= 0)
)
"#;

pub(crate) const CREATE_SCHEDULE_OCCURRENCES: &str = r#"
CREATE TABLE IF NOT EXISTS schedule_occurrences (
    schedule_id TEXT NOT NULL REFERENCES schedules(schedule_id) ON DELETE RESTRICT,
    scheduled_for_ms INTEGER NOT NULL CHECK (scheduled_for_ms >= 0),
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    schedule_revision INTEGER NOT NULL CHECK (schedule_revision > 0),
    idempotency_key TEXT NOT NULL UNIQUE,
    run_template_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('running', 'succeeded', 'failed')),
    operation_id TEXT,
    error_code TEXT,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    PRIMARY KEY (schedule_id, scheduled_for_ms),
    CHECK (
        (state = 'running' AND operation_id IS NULL AND error_code IS NULL)
        OR (state = 'succeeded' AND operation_id IS NOT NULL AND error_code IS NULL)
        OR (state = 'failed' AND error_code IS NOT NULL)
    )
)
"#;

pub(crate) const CREATE_SCHEDULE_OCCURRENCES_PENDING_INDEX: &str = r#"
CREATE INDEX IF NOT EXISTS schedule_occurrences_pending_idx
ON schedule_occurrences (scheduled_for_ms, schedule_id)
WHERE state = 'running'
"#;

pub(crate) const ADD_SCHEDULE_ADMISSION_WATERMARK: &str = r#"
ALTER TABLE schedules ADD COLUMN admitted_through_ms INTEGER CHECK (
    admitted_through_ms IS NULL
    OR (admitted_through_ms >= 0 AND admitted_through_ms % 60000 = 0)
)
"#;

pub(crate) const BACKFILL_SCHEDULE_ADMISSION_WATERMARK: &str = r#"
UPDATE schedules
SET admitted_through_ms = (
    SELECT MAX(schedule_occurrences.scheduled_for_ms)
    FROM schedule_occurrences
    WHERE schedule_occurrences.schedule_id = schedules.schedule_id
)
WHERE EXISTS (
    SELECT 1
    FROM schedule_occurrences
    WHERE schedule_occurrences.schedule_id = schedules.schedule_id
)
"#;

pub(crate) const COMPACT_SCHEDULE_OCCURRENCES_V20: &str = r#"
DELETE FROM schedule_occurrences
WHERE rowid IN (
    SELECT rowid
    FROM (
        SELECT
            rowid,
            ROW_NUMBER() OVER (
                PARTITION BY schedule_id
                ORDER BY scheduled_for_ms DESC
            ) AS retention_rank
        FROM schedule_occurrences
        WHERE state != 'running'
    )
    WHERE retention_rank > 256
)
"#;
pub(crate) const CREATE_SCHEDULE_OCCURRENCES_V39: &str = r#"
CREATE TABLE IF NOT EXISTS schedule_occurrences (
    idempotency_key TEXT PRIMARY KEY,
    schedule_id TEXT NOT NULL REFERENCES schedules(schedule_id) ON DELETE RESTRICT,
    scheduled_for_ms INTEGER CHECK (scheduled_for_ms >= 0 AND scheduled_for_ms % 60000 = 0),
    schema_version INTEGER NOT NULL CHECK (schema_version IN (1, 2)),
    schedule_revision INTEGER NOT NULL CHECK (schedule_revision > 0),
    run_template_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'started', 'failed')),
    operation_id TEXT UNIQUE,
    dispatch_id TEXT UNIQUE REFERENCES workflow_dispatches(dispatch_id) ON DELETE RESTRICT,
    error_code TEXT,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    UNIQUE (schedule_id, scheduled_for_ms),
    CHECK (
        (state = 'pending' AND error_code IS NULL)
        OR (state = 'started' AND operation_id IS NOT NULL AND error_code IS NULL)
        OR (state = 'failed' AND error_code IS NOT NULL)
    )
)
"#;

pub(crate) const CREATE_SCHEDULE_OCCURRENCES_PENDING_INDEX_V39: &str = r#"
CREATE INDEX IF NOT EXISTS schedule_occurrences_pending_idx
ON schedule_occurrences (created_at_ms, idempotency_key) WHERE state = 'pending'
"#;

pub(crate) const SCHEDULE_OCCURRENCES_V39_MIGRATION: &[&str] = &[
    "DROP INDEX IF EXISTS schedule_occurrences_pending_idx",
    "ALTER TABLE schedule_occurrences RENAME TO schedule_occurrences_v38",
    CREATE_SCHEDULE_OCCURRENCES_V39,
    r#"INSERT INTO schedule_occurrences (
        idempotency_key, schedule_id, scheduled_for_ms, schema_version, schedule_revision,
        run_template_json, state, operation_id, error_code, created_at_ms, updated_at_ms
    ) SELECT idempotency_key, schedule_id, scheduled_for_ms, 1, schedule_revision,
        run_template_json, CASE state WHEN 'running' THEN 'pending'
            WHEN 'succeeded' THEN 'started' ELSE 'failed' END,
        operation_id, error_code, created_at_ms, updated_at_ms
    FROM schedule_occurrences_v38"#,
    "DROP TABLE schedule_occurrences_v38",
    CREATE_SCHEDULE_OCCURRENCES_PENDING_INDEX_V39,
];
