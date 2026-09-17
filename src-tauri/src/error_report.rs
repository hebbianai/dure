use serde_json::Value;
use std::io::Write;
use std::path::Path;

const ERROR_REPORT_KIND: &str = "dure.error-report";
const ERROR_REPORT_SCHEMA_VERSION: u64 = 1;
const MAX_REPORT_BYTES: usize = 256 * 1024;
const TOP_LEVEL_FIELDS: &[&str] = &[
    "schemaVersion",
    "kind",
    "createdAt",
    "app",
    "incident",
    "diagnostics",
    "reproduction",
    "privacy",
];
const APP_FIELDS: &[&str] = &["frontendBuildId", "channel"];
const INCIDENT_FIELDS: &[&str] = &[
    "fingerprint",
    "boundary",
    "surface",
    "occurredAt",
    "error",
    "componentStack",
];
const ERROR_FIELDS: &[&str] = &["name", "message", "stack"];
const DIAGNOSTIC_FIELDS: &[&str] = &["kind", "code", "reference"];
const REPRODUCTION_FIELDS: &[&str] = &["notes"];
const PRIVACY_FIELDS: &[&str] = &[
    "redactionVersion",
    "redactionMarker",
    "excludedByDefault",
];
const EXCLUDED_BY_DEFAULT: &[&str] = &[
    "terminal_scrollback",
    "prompts",
    "credentials",
    "environment_values",
    "absolute_paths",
    "attachments",
];

/// Persist one user-reviewed diagnostic bundle. Collection and redaction are
/// frontend presentation concerns; this adapter only validates the versioned
/// export envelope and performs a bounded, owner-only atomic file replacement.
#[tauri::command(async)]
pub(crate) fn save_error_report_bundle(path: String, bundle: Value) -> Result<(), String> {
    save_bundle(Path::new(&path), &bundle)
}

fn validate_bundle(bundle: &Value) -> Result<Vec<u8>, String> {
    let object = object_with_fields(bundle, TOP_LEVEL_FIELDS, "bundle")?;
    if object
        .get("schemaVersion")
        .and_then(Value::as_u64)
        != Some(ERROR_REPORT_SCHEMA_VERSION)
        || object.get("kind").and_then(Value::as_str) != Some(ERROR_REPORT_KIND)
    {
        return Err("Error report bundle schema is unsupported".into());
    }
    required_string(object.get("createdAt"), "createdAt")?;
    let app = object_with_fields(
        object.get("app").unwrap_or(&Value::Null),
        APP_FIELDS,
        "app",
    )?;
    required_string(app.get("frontendBuildId"), "frontendBuildId")?;
    required_string(app.get("channel"), "channel")?;
    validate_incident(object.get("incident").unwrap_or(&Value::Null))?;
    validate_diagnostics(object.get("diagnostics").unwrap_or(&Value::Null))?;
    let reproduction = object_with_fields(
        object.get("reproduction").unwrap_or(&Value::Null),
        REPRODUCTION_FIELDS,
        "reproduction",
    )?;
    required_string(reproduction.get("notes"), "notes")?;
    validate_privacy(object.get("privacy").unwrap_or(&Value::Null))?;
    let mut serialized = serde_json::to_vec_pretty(bundle).map_err(|error| error.to_string())?;
    serialized.push(b'\n');
    if serialized.len() > MAX_REPORT_BYTES {
        return Err("Error report bundle exceeds the size limit".into());
    }
    Ok(serialized)
}

fn object_with_fields<'a>(
    value: &'a Value,
    allowed: &[&str],
    label: &str,
) -> Result<&'a serde_json::Map<String, Value>, String> {
    let object = value
        .as_object()
        .ok_or_else(|| format!("Error report {label} must be a JSON object"))?;
    if object
        .keys()
        .any(|field| !allowed.contains(&field.as_str()))
    {
        return Err(format!(
            "Error report {label} has an unsupported field"
        ));
    }
    Ok(object)
}

fn required_string<'a>(value: Option<&'a Value>, label: &str) -> Result<&'a str, String> {
    value
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Error report {label} must be a string"))
}

fn validate_incident(value: &Value) -> Result<(), String> {
    let incident = object_with_fields(value, INCIDENT_FIELDS, "incident")?;
    required_string(incident.get("fingerprint"), "fingerprint")?;
    let boundary = required_string(incident.get("boundary"), "boundary")?;
    if !matches!(boundary, "app" | "diff-window" | "entry") {
        return Err("Error report boundary is unsupported".into());
    }
    let surface = required_string(incident.get("surface"), "surface")?;
    if !matches!(surface, "main" | "diff-window") {
        return Err("Error report surface is unsupported".into());
    }
    required_string(incident.get("occurredAt"), "occurredAt")?;
    let error = object_with_fields(
        incident.get("error").unwrap_or(&Value::Null),
        ERROR_FIELDS,
        "error",
    )?;
    required_string(error.get("name"), "error name")?;
    required_string(error.get("message"), "error message")?;
    if let Some(stack) = error.get("stack") {
        required_string(Some(stack), "error stack")?;
    }
    if let Some(component_stack) = incident.get("componentStack") {
        required_string(Some(component_stack), "component stack")?;
    }
    Ok(())
}

fn validate_diagnostics(value: &Value) -> Result<(), String> {
    let diagnostics = value
        .as_array()
        .ok_or_else(|| "Error report diagnostics must be an array".to_string())?;
    for diagnostic in diagnostics {
        let diagnostic =
            object_with_fields(diagnostic, DIAGNOSTIC_FIELDS, "diagnostic reference")?;
        let kind = required_string(diagnostic.get("kind"), "diagnostic kind")?;
        if !matches!(kind, "backend_receipt" | "hmux_connection" | "render") {
            return Err("Error report diagnostic kind is unsupported".into());
        }
        required_string(diagnostic.get("code"), "diagnostic code")?;
        if let Some(reference) = diagnostic.get("reference") {
            required_string(Some(reference), "diagnostic reference")?;
        }
    }
    Ok(())
}

fn validate_privacy(value: &Value) -> Result<(), String> {
    let privacy = object_with_fields(value, PRIVACY_FIELDS, "privacy")?;
    let excluded = privacy
        .get("excludedByDefault")
        .and_then(Value::as_array)
        .ok_or_else(|| "Error report privacy exclusions must be an array".to_string())?;
    if privacy.get("redactionVersion").and_then(Value::as_u64) != Some(1)
        || privacy.get("redactionMarker").and_then(Value::as_str) != Some("[redacted]")
        || excluded.len() != EXCLUDED_BY_DEFAULT.len()
        || excluded
            .iter()
            .zip(EXCLUDED_BY_DEFAULT)
            .any(|(value, expected)| value.as_str() != Some(expected))
    {
        return Err("Error report privacy contract is unsupported".into());
    }
    Ok(())
}

fn validate_destination(path: &Path) -> Result<&Path, String> {
    if !path.is_absolute() {
        return Err("Error report destination must be an absolute path".into());
    }
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
    {
        return Err("Error report destination must use the .json extension".into());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "Error report destination has no parent directory".to_string())?;
    let parent_metadata = parent.symlink_metadata().map_err(|error| error.to_string())?;
    if !parent_metadata.is_dir() {
        return Err("Error report destination directory is unavailable".into());
    }
    match path.symlink_metadata() {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err("Error report destination is unsafe".into())
        }
        Ok(_) => Ok(parent),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(parent),
        Err(error) => Err(error.to_string()),
    }
}

fn save_bundle(path: &Path, bundle: &Value) -> Result<(), String> {
    let serialized = validate_bundle(bundle)?;
    let parent = validate_destination(path)?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Error report destination filename is invalid".to_string())?;
    let token = crate::server::gen_token().map_err(|error| error.to_string())?;
    let temporary = parent.join(format!(".{file_name}.{token}.tmp"));
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(&serialized)
            .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))
                .map_err(|error| error.to_string())?;
        }
        replace_file(&temporary, path, parent, &token)?;
        #[cfg(unix)]
        std::fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| error.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

#[cfg(not(windows))]
fn replace_file(temporary: &Path, path: &Path, _parent: &Path, _token: &str) -> Result<(), String> {
    std::fs::rename(temporary, path).map_err(|error| error.to_string())
}

#[cfg(windows)]
fn replace_file(temporary: &Path, path: &Path, parent: &Path, token: &str) -> Result<(), String> {
    if !path.exists() {
        return std::fs::rename(temporary, path).map_err(|error| error.to_string());
    }
    let backup = parent.join(format!(".error-report.{token}.backup"));
    std::fs::rename(path, &backup).map_err(|error| error.to_string())?;
    match std::fs::rename(temporary, path) {
        Ok(()) => {
            std::fs::remove_file(backup).map_err(|error| error.to_string())?;
            Ok(())
        }
        Err(error) => {
            let _ = std::fs::rename(&backup, path);
            Err(error.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bundle() -> Value {
        serde_json::json!({
            "schemaVersion": 1,
            "kind": "dure.error-report",
            "createdAt": "2026-07-29T10:00:00.000Z",
            "app": {
                "frontendBuildId": "0.1.4+abc",
                "channel": "stable"
            },
            "incident": {
                "fingerprint": "error-v1-abc",
                "boundary": "app",
                "surface": "main",
                "occurredAt": "2026-07-29T09:59:00.000Z",
                "error": {
                    "name": "Error",
                    "message": "render failed"
                }
            },
            "diagnostics": [],
            "reproduction": {
                "notes": ""
            },
            "privacy": {
                "redactionVersion": 1,
                "redactionMarker": "[redacted]",
                "excludedByDefault": [
                    "terminal_scrollback",
                    "prompts",
                    "credentials",
                    "environment_values",
                    "absolute_paths",
                    "attachments"
                ]
            }
        })
    }

    #[test]
    fn writes_a_bounded_owner_only_json_bundle() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("dure-error.json");

        save_bundle(&path, &bundle()).unwrap();

        let stored = std::fs::read_to_string(&path).unwrap();
        assert!(stored.ends_with('\n'));
        assert_eq!(serde_json::from_str::<Value>(&stored).unwrap(), bundle());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                path.metadata().unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn rejects_relative_non_json_and_unknown_schema_destinations() {
        let directory = tempfile::tempdir().unwrap();
        assert!(save_bundle(Path::new("report.json"), &bundle())
            .unwrap_err()
            .contains("absolute"));
        assert!(save_bundle(&directory.path().join("report.txt"), &bundle())
            .unwrap_err()
            .contains(".json"));
        let mut future = bundle();
        future["schemaVersion"] = Value::from(2);
        assert!(save_bundle(&directory.path().join("future.json"), &future)
            .unwrap_err()
            .contains("schema"));
    }

    #[test]
    fn rejects_unknown_fields_and_oversized_bundles() {
        let directory = tempfile::tempdir().unwrap();
        let mut unknown = bundle();
        unknown["rawTerminal"] = Value::from("secret");
        assert!(save_bundle(&directory.path().join("unknown.json"), &unknown)
            .unwrap_err()
            .contains("unsupported"));
        let mut nested = bundle();
        nested["incident"]["rawTerminal"] = Value::from("secret");
        assert!(save_bundle(&directory.path().join("nested.json"), &nested)
            .unwrap_err()
            .contains("unsupported"));

        let mut oversized = bundle();
        oversized["reproduction"]["notes"] = Value::from("x".repeat(MAX_REPORT_BYTES));
        assert!(save_bundle(&directory.path().join("large.json"), &oversized)
            .unwrap_err()
            .contains("size"));
    }

    #[cfg(unix)]
    #[test]
    fn refuses_to_follow_an_existing_destination_symlink() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("target.json");
        let destination = directory.path().join("report.json");
        std::fs::write(&target, "preserve").unwrap();
        symlink(&target, &destination).unwrap();

        assert!(save_bundle(&destination, &bundle())
            .unwrap_err()
            .contains("unsafe"));
        assert_eq!(std::fs::read_to_string(target).unwrap(), "preserve");
    }
}
