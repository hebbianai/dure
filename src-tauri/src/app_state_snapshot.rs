use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use fs2::FileExt;
use std::fs::{File, OpenOptions};
use std::io::Write;

const MAX_SNAPSHOTS: usize = 20;
const MIN_SNAPSHOT_INTERVAL_SECS: u64 = 600; // 10 minutes

fn owner_only_options(_options: &mut OpenOptions) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        _options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
}

fn snapshot_directory() -> Result<PathBuf, String> {
    let (app_root, _) = crate::app_home::app_root_resolution()?;
    let backup_dir = app_root.join("backups").join("app-state");
    std::fs::create_dir_all(&backup_dir).map_err(|error| error.to_string())?;
    Ok(backup_dir)
}

fn list_snapshots(directory: &Path) -> Result<Vec<(PathBuf, SystemTime)>, String> {
    let mut snapshots: Vec<(PathBuf, SystemTime)> = Vec::new();

    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(snapshots),
        Err(error) => return Err(error.to_string()),
    };

    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();

        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if name.starts_with("agent-ide-") && name.ends_with(".json") {
                if let Ok(metadata) = std::fs::metadata(&path) {
                    if let Ok(modified) = metadata.modified() {
                        snapshots.push((path, modified));
                    }
                }
            }
        }
    }

    snapshots.sort_by(|a, b| a.1.cmp(&b.1));
    Ok(snapshots)
}

fn should_take_snapshot(directory: &Path) -> Result<bool, String> {
    let snapshots = list_snapshots(directory)?;

    if let Some((_, last_time)) = snapshots.last() {
        let now = SystemTime::now();
        let elapsed = now.duration_since(*last_time)
            .map_err(|error| error.to_string())?;

        if elapsed.as_secs() < MIN_SNAPSHOT_INTERVAL_SECS {
            return Ok(false);
        }
    }

    Ok(true)
}

fn rotate_snapshots(directory: &Path) -> Result<(), String> {
    let mut snapshots = list_snapshots(directory)?;

    while snapshots.len() >= MAX_SNAPSHOTS {
        if let Some((oldest, _)) = snapshots.first() {
            std::fs::remove_file(oldest).map_err(|error| error.to_string())?;
            snapshots.remove(0);
        } else {
            break;
        }
    }

    Ok(())
}

fn is_empty_state(json: &str) -> bool {
    match serde_json::from_str::<serde_json::Value>(json) {
        Ok(value) => {
            if let Some(obj) = value.as_object() {
                if let Some(state) = obj.get("state").and_then(|s| s.as_object()) {
                    let has_agents = state.get("agents")
                        .and_then(|a| a.as_array())
                        .map_or(false, |a| !a.is_empty());
                    let has_accounts = state.get("accounts")
                        .and_then(|a| a.as_array())
                        .map_or(false, |a| !a.is_empty());
                    let has_projects = state.get("projects")
                        .and_then(|p| p.as_array())
                        .map_or(false, |p| !p.is_empty());
                    let has_layouts = state.get("layouts")
                        .and_then(|l| l.as_object())
                        .map_or(false, |l| !l.is_empty());

                    return !has_agents && !has_accounts && !has_projects && !has_layouts;
                }
            }
            true
        }
        Err(_) => true,
    }
}

pub(crate) fn take_snapshot(value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err("Cannot snapshot empty value".to_string());
    }

    // Refuse to snapshot empty state over existing non-empty state
    if is_empty_state(value) {
        let directory = snapshot_directory()?;
        let snapshots = list_snapshots(&directory)?;

        if let Some((last_path, _)) = snapshots.last() {
            let last_content = std::fs::read_to_string(last_path)
                .map_err(|error| error.to_string())?;
            if !is_empty_state(&last_content) {
                return Err("Refusing to snapshot empty state over non-empty state".to_string());
            }
        }
    }

    let directory = snapshot_directory()?;

    if !should_take_snapshot(&directory)? {
        return Ok(());
    }

    rotate_snapshots(&directory)?;

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs();

    let snapshot_name = format!("agent-ide-{}.json", timestamp);
    let snapshot_path = directory.join(snapshot_name);
    let temp_path = directory.join(format!(".agent-ide-{}.tmp", timestamp));

    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    owner_only_options(&mut options);

    let mut file = options.open(&temp_path)
        .map_err(|error| error.to_string())?;

    file.write_all(value.as_bytes())
        .map_err(|error| error.to_string())?;

    file.sync_all().map_err(|error| error.to_string())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
    }

    drop(file);

    std::fs::rename(&temp_path, &snapshot_path)
        .map_err(|error| error.to_string())?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_empty_snapshot_over_non_empty() {
        let temp_dir = tempfile::tempdir().unwrap();
        std::env::set_var("DURE_HOME", temp_dir.path());

        let directory = snapshot_directory().unwrap();

        // Take initial non-empty snapshot
        let non_empty = r#"{"version":7,"state":{"agents":[{"id":"test"}],"accounts":[],"projects":[],"layouts":{}}}"#;
        take_snapshot(non_empty).unwrap();

        // Attempt to snapshot empty state should fail
        let empty = r#"{"version":7,"state":{"agents":[],"accounts":[],"projects":[],"layouts":{}}}"#;
        let result = take_snapshot(empty);

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Refusing to snapshot empty state"));

        // Verify only the non-empty snapshot exists
        let snapshots = list_snapshots(&directory).unwrap();
        assert_eq!(snapshots.len(), 1);
    }

    #[test]
    fn rotates_old_snapshots() {
        let temp_dir = tempfile::tempdir().unwrap();
        std::env::set_var("DURE_HOME", temp_dir.path());

        let directory = snapshot_directory().unwrap();

        // Create MAX_SNAPSHOTS + 5 snapshot files
        for i in 0..(MAX_SNAPSHOTS + 5) {
            let name = format!("agent-ide-{}.json", 1000000 + i);
            let path = directory.join(name);
            let content = format!(r#"{{"version":7,"state":{{"agents":[{{"id":"test{}"}}],"accounts":[],"projects":[],"layouts":{{}}}}}}"#, i);
            std::fs::write(&path, content).unwrap();
        }

        rotate_snapshots(&directory).unwrap();

        let snapshots = list_snapshots(&directory).unwrap();
        assert_eq!(snapshots.len(), MAX_SNAPSHOTS - 1);
    }

    #[test]
    fn identifies_empty_state() {
        let empty = r#"{"version":7,"state":{"agents":[],"accounts":[],"projects":[],"layouts":{}}}"#;
        assert!(is_empty_state(empty));

        let non_empty_agents = r#"{"version":7,"state":{"agents":[{"id":"test"}],"accounts":[],"projects":[],"layouts":{}}}"#;
        assert!(!is_empty_state(non_empty_agents));

        let non_empty_accounts = r#"{"version":7,"state":{"agents":[],"accounts":[{"id":"test"}],"projects":[],"layouts":{}}}"#;
        assert!(!is_empty_state(non_empty_accounts));

        let non_empty_layouts = r#"{"version":7,"state":{"agents":[],"accounts":[],"projects":[],"layouts":{"desk-1":{}}}}"#;
        assert!(!is_empty_state(non_empty_layouts));
    }
}
