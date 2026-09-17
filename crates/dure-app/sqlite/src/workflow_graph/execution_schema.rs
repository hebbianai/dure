// The coordinator is an actor reference. Agent-led Runs keep their exact
// session binding; service-led Runs do not fabricate an agent or PTY identity.
macro_rules! runs {
    ($table:literal) => { concat!("CREATE TABLE IF NOT EXISTS ", $table, r#" (
        run_id TEXT PRIMARY KEY,
        contribution_id TEXT NOT NULL,
        coordinator_agent_id TEXT,
        coordinator_session_id TEXT,
        coordinator_binding_generation INTEGER CHECK (coordinator_binding_generation > 0),
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        coordinator_kind TEXT NOT NULL DEFAULT 'agent' CHECK (coordinator_kind IN ('agent', 'service')),
        coordinator_ref TEXT,
        CHECK ((coordinator_kind = 'agent' AND coordinator_agent_id IS NOT NULL
            AND coordinator_session_id IS NOT NULL AND coordinator_binding_generation IS NOT NULL AND coordinator_ref IS NULL)
            OR (coordinator_kind = 'service' AND coordinator_agent_id IS NULL
            AND coordinator_session_id IS NULL AND coordinator_binding_generation IS NULL AND coordinator_ref IS NOT NULL))
    )"#) };
}

macro_rules! dispatches {
    ($table:literal) => {
        concat!(
            "CREATE TABLE IF NOT EXISTS ",
            $table,
            r#" (
        dispatch_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES workflow_tasks(task_id) ON DELETE RESTRICT,
        provider_id TEXT,
        runtime_kind_id TEXT NOT NULL,
        target_reference TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation > 0),
        state TEXT NOT NULL CHECK (state IN ('starting', 'completed')),
        completion_result TEXT,
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
        UNIQUE (task_id, generation),
        CHECK (provider_id IS NOT NULL OR runtime_kind_id = 'runtime.action')
    )"#
        )
    };
}

pub(crate) const RUNS: &str = runs!("workflow_runs");
pub(crate) const DISPATCHES: &str = dispatches!("workflow_dispatches");

pub(crate) const SOURCES: &str = r#"
CREATE TABLE IF NOT EXISTS workflow_run_sources (
    run_id TEXT PRIMARY KEY REFERENCES workflow_runs(run_id) ON DELETE RESTRICT,
    workflow_id TEXT NOT NULL,
    workflow_version INTEGER NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    revision INTEGER NOT NULL CHECK (revision > 0),
    settled INTEGER NOT NULL CHECK (settled IN (0, 1)),
    summary_json TEXT NOT NULL CHECK (json_valid(summary_json)),
    record_json TEXT NOT NULL CHECK (json_valid(record_json)),
    FOREIGN KEY (workflow_id, workflow_version) REFERENCES workflow_versions(workflow_id, version) ON DELETE RESTRICT
)
"#;

// Bind the immutable plan event, not its rebuildable receipt projection.
pub(crate) const EFFECTS: &str = r#"
CREATE TABLE IF NOT EXISTS workflow_action_effects (
    dispatch_id TEXT PRIMARY KEY REFERENCES workflow_dispatches(dispatch_id) ON DELETE RESTRICT,
    operation_id TEXT NOT NULL UNIQUE,
    plan_sequence INTEGER NOT NULL DEFAULT 1 CHECK (plan_sequence = 1),
    report_dispatch_id TEXT UNIQUE REFERENCES workflow_dispatches(dispatch_id) ON DELETE RESTRICT,
    FOREIGN KEY (operation_id, plan_sequence) REFERENCES agent_spawn_events(operation_id, sequence) ON DELETE RESTRICT
)
"#;

pub(crate) const EVENTS: &str = r#"
CREATE TABLE IF NOT EXISTS workflow_run_events (
    run_id TEXT NOT NULL REFERENCES workflow_runs(run_id) ON DELETE RESTRICT,
    revision INTEGER NOT NULL CHECK (revision > 0),
    kind TEXT NOT NULL,
    dispatch_id TEXT REFERENCES workflow_dispatches(dispatch_id) ON DELETE RESTRICT,
    observed_at_ms INTEGER NOT NULL,
    PRIMARY KEY (run_id, revision)
)
"#;

pub(crate) const ACTIVE_INDEX: &str = "CREATE INDEX IF NOT EXISTS workflow_run_sources_active ON workflow_run_sources(settled, run_id)";

pub(crate) const MIGRATION: &[&str] = &[
    runs!("workflow_runs_next"),
    "INSERT INTO workflow_runs_next (run_id, contribution_id, coordinator_agent_id, coordinator_session_id, coordinator_binding_generation, created_at_ms) SELECT run_id, contribution_id, coordinator_agent_id, coordinator_session_id, coordinator_binding_generation, created_at_ms FROM workflow_runs",
    "DROP TABLE workflow_runs",
    "ALTER TABLE workflow_runs_next RENAME TO workflow_runs",
    dispatches!("workflow_dispatches_next"),
    "INSERT INTO workflow_dispatches_next (dispatch_id, task_id, provider_id, runtime_kind_id, target_reference, generation, state, completion_result, created_at_ms, updated_at_ms) SELECT dispatch_id, task_id, provider_id, runtime_kind_id, target_reference, generation, state, completion_result, created_at_ms, updated_at_ms FROM workflow_dispatches",
    "DROP TABLE workflow_dispatches",
    "ALTER TABLE workflow_dispatches_next RENAME TO workflow_dispatches",
    super::schema::DEFINITIONS,
    super::schema::VERSIONS,
    super::schema::RECEIPTS,
    SOURCES,
    EFFECTS,
    EVENTS,
    ACTIVE_INDEX,
];
