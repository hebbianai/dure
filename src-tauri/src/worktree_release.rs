use std::io::{self, Read};

use serde::Deserialize;

const MAX_ENVELOPE_BYTES: u64 = 17 * 1024 * 1024;
const PRESENTATION_FILE: &str = "worktree-presentation-v1.json";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorktreeReleaseProfile {
    pub(crate) source_channel: String,
    pub(crate) target_channel: String,
    identifier: String,
    data_store_identifier: [u8; 16],
}

fn parse_profile(raw: &str) -> io::Result<WorktreeReleaseProfile> {
    let profile: WorktreeReleaseProfile = serde_json::from_str(raw)
        .map_err(|_| io::Error::other("invalid worktree release profile"))?;
    let valid_channel = |value: &str, prefix: &str| {
        value.starts_with(prefix)
            && value.len() > prefix.len()
            && value.len() <= 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    };
    let valid_identifier = profile
        .identifier
        .strip_prefix("io.hebbian.ade.release.")
        .is_some_and(|suffix| {
            suffix.len() == 10
                && suffix
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                && profile.source_channel.ends_with(&format!("-{suffix}"))
        });
    if !valid_channel(&profile.source_channel, "dev-")
        || !valid_channel(&profile.target_channel, "release-")
        || profile.source_channel.strip_prefix("dev-")
            != profile.target_channel.strip_prefix("release-")
        || !valid_identifier
    {
        return Err(io::Error::other("invalid worktree release identity"));
    }
    Ok(profile)
}

pub(crate) fn profile() -> io::Result<Option<WorktreeReleaseProfile>> {
    option_env!("DURE_WORKTREE_RELEASE_PROFILE")
        .map(parse_profile)
        .transpose()
}

pub(crate) fn resolve_channel(configured: Option<String>) -> io::Result<Option<String>> {
    let Some(profile) = profile()? else {
        return Ok(configured);
    };
    if configured
        .as_ref()
        .is_some_and(|channel| channel != &profile.target_channel)
    {
        return Err(io::Error::other(
            "worktree release app channel override conflicts with its build",
        ));
    }
    Ok(Some(profile.target_channel))
}

pub(crate) fn apply(context: &mut tauri::Context<tauri::Wry>) -> io::Result<()> {
    let Some(profile) = profile()? else {
        return Ok(());
    };
    if context.config().identifier != profile.identifier || context.config().app.windows.is_empty()
    {
        return Err(io::Error::other(
            "worktree release bundle identity mismatch",
        ));
    }
    // Check the runtime channel before any legacy migration or app service starts.
    if crate::app_channel::current_name()? != profile.target_channel {
        return Err(io::Error::other("worktree release app channel mismatch"));
    }
    for window in &mut context.config_mut().app.windows {
        window.data_store_identifier = Some(profile.data_store_identifier);
    }
    Ok(())
}

fn presentation_path() -> Result<std::path::PathBuf, String> {
    let profile = profile()
        .map_err(|error| error.to_string())?
        .ok_or("not a worktree release build")?;
    let channel = crate::app_channel::current().map_err(|error| error.to_string())?;
    if channel.name != profile.target_channel {
        return Err("worktree release app channel mismatch".into());
    }
    Ok(channel.control_dir.join(PRESENTATION_FILE))
}

#[derive(serde::Serialize)]
pub(crate) struct WorktreePresentationRead {
    imported: bool,
    envelope: String,
}

fn presentation_file_exists(path: &std::path::Path) -> Result<bool, String> {
    match path.symlink_metadata() {
        Ok(metadata) if metadata.is_file() && metadata.len() <= MAX_ENVELOPE_BYTES => Ok(true),
        Ok(_) => Err("invalid worktree presentation file".into()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

fn read_presentation_at(path: &std::path::Path) -> Result<WorktreePresentationRead, String> {
    let backup = path.with_extension("json.imported");
    let imported = presentation_file_exists(&backup)?;
    let pending = presentation_file_exists(path)?;
    if imported == pending {
        return Err("worktree presentation archive state is incomplete or conflicting".into());
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options
        .open(if imported { &backup } else { path })
        .map_err(|error| error.to_string())?;
    let mut raw = String::new();
    file.take(MAX_ENVELOPE_BYTES + 1)
        .read_to_string(&mut raw)
        .map_err(|error| error.to_string())?;
    if raw.len() as u64 > MAX_ENVELOPE_BYTES {
        return Err("worktree presentation file exceeds its limit".into());
    }
    Ok(WorktreePresentationRead {
        imported,
        envelope: raw,
    })
}

#[tauri::command(async)]
pub(crate) fn read_worktree_presentation() -> Result<WorktreePresentationRead, String> {
    read_presentation_at(&presentation_path()?)
}

fn complete_presentation_at(path: &std::path::Path) -> Result<(), String> {
    let imported = path.with_extension("json.imported");
    if presentation_file_exists(&imported)? {
        if presentation_file_exists(path)? {
            return Err("worktree presentation archive conflicts with a pending import".into());
        }
        return Ok(());
    }
    if !presentation_file_exists(path)? {
        return Err("worktree presentation import is missing".into());
    }
    match std::fs::rename(path, &imported) {
        Ok(()) => {
            #[cfg(unix)]
            std::fs::File::open(path.parent().ok_or("missing presentation directory")?)
                .and_then(|directory| directory.sync_all())
                .map_err(|error| error.to_string())?;
            Ok(())
        }
        Err(error)
            if error.kind() == io::ErrorKind::NotFound && presentation_file_exists(&imported)? =>
        {
            Ok(())
        }
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command(async)]
pub(crate) fn complete_worktree_presentation() -> Result<(), String> {
    complete_presentation_at(&presentation_path()?)
}

#[cfg(test)]
mod tests {
    use super::{complete_presentation_at, parse_profile, read_presentation_at};

    #[test]
    fn archives_once_and_preserves_the_exact_recovery_copy() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("worktree-presentation-v1.json");
        let raw = "opaque envelope bytes retained without rewriting";
        std::fs::write(&path, raw).unwrap();
        let pending = read_presentation_at(&path).unwrap();
        assert!(!pending.imported);
        assert_eq!(pending.envelope, raw);
        complete_presentation_at(&path).unwrap();
        complete_presentation_at(&path).unwrap();
        assert!(!path.exists());
        let consumed = read_presentation_at(&path).unwrap();
        assert!(consumed.imported);
        assert_eq!(consumed.envelope, raw);
    }

    #[test]
    fn missing_or_conflicting_files_never_become_a_completed_import() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("worktree-presentation-v1.json");
        assert!(read_presentation_at(&path).is_err());
        assert!(complete_presentation_at(&path).is_err());
        std::fs::write(&path, "pending").unwrap();
        let backup = path.with_extension("json.imported");
        std::fs::write(&backup, "prior recovery copy").unwrap();
        assert!(read_presentation_at(&path).is_err());
        assert!(complete_presentation_at(&path).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "pending");
        assert_eq!(
            std::fs::read_to_string(&backup).unwrap(),
            "prior recovery copy"
        );
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinked_pending_and_archived_files() {
        let root = tempfile::tempdir().unwrap();
        let original = root.path().join("source");
        std::fs::write(&original, "preserved").unwrap();
        let path = root.path().join("worktree-presentation-v1.json");
        std::os::unix::fs::symlink(&original, &path).unwrap();
        assert!(read_presentation_at(&path).is_err());
        assert!(complete_presentation_at(&path).is_err());
        std::fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(&original, path.with_extension("json.imported")).unwrap();
        assert!(read_presentation_at(&path).is_err());
        assert!(complete_presentation_at(&path).is_err());
        assert_eq!(std::fs::read_to_string(original).unwrap(), "preserved");
    }

    #[test]
    fn rejects_stable_and_cross_domain_release_identities() {
        let valid = serde_json::json!({
            "sourceChannel": "dev-task-0123456789", "targetChannel": "release-task-0123456789",
            "identifier": "io.hebbian.ade.release.0123456789", "dataStoreIdentifier": vec![0; 16],
        });
        assert!(parse_profile(&valid.to_string()).is_ok());
        for (key, replacement) in [
            ("sourceChannel", "stable"),
            ("targetChannel", "stable"),
            ("targetChannel", "release-../escape"),
            ("targetChannel", "release-other-0123456789"),
            ("identifier", "io.hebbian.ade"),
            ("identifier", "io.hebbian.ade.release.other"),
            ("identifier", "io.hebbian.ade.release.aaaaaaaaaa"),
        ] {
            let mut invalid = valid.clone();
            invalid[key] = replacement.into();
            assert!(parse_profile(&invalid.to_string()).is_err());
        }
    }
}
