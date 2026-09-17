pub(crate) const DEFINITIONS: &str = r#"
CREATE TABLE IF NOT EXISTS workflow_definitions (
    workflow_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK (revision > 0),
    record_json TEXT NOT NULL CHECK (json_valid(record_json))
)
"#;

pub(crate) const VERSIONS: &str = r#"
CREATE TABLE IF NOT EXISTS workflow_versions (
    workflow_id TEXT NOT NULL REFERENCES workflow_definitions(workflow_id) ON DELETE RESTRICT,
    version INTEGER NOT NULL CHECK (version > 0),
    record_json TEXT NOT NULL CHECK (json_valid(record_json)),
    PRIMARY KEY (workflow_id, version)
)
"#;

pub(crate) const RECEIPTS: &str = r#"
CREATE TABLE IF NOT EXISTS workflow_definition_receipts (
    idempotency_key TEXT PRIMARY KEY,
    request_digest TEXT NOT NULL,
    result_json TEXT NOT NULL CHECK (json_valid(result_json))
)
"#;
