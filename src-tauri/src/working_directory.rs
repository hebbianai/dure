use std::io;
use std::path::{Path, PathBuf};

fn nearest_repository_root(path: &Path) -> Option<PathBuf> {
    let mut existing = path.to_path_buf();
    while !existing.is_dir() {
        if !existing.pop() {
            return None;
        }
    }
    let existing = existing.to_str()?;
    let root = crate::gitx::run_git(existing, &["rev-parse", "--show-toplevel"]).ok()?;
    let root = std::fs::canonicalize(root.trim()).ok()?;
    root.is_dir().then_some(root)
}

/// Resolve launch placement for an exact provider conversation whose old Host
/// may outlive its checkout. A missing checkout is replaceable placement state:
/// preserve repository context when possible, then use the user's home. Other
/// filesystem failures remain errors instead of being masked by fallback.
pub(crate) fn resolve_exact_resume_cwd(recorded: &str) -> io::Result<PathBuf> {
    let recorded = Path::new(recorded.trim());
    let missing = match std::fs::canonicalize(recorded) {
        Ok(path) if path.is_dir() => return Ok(path),
        Ok(_) => {
            return Err(io::Error::new(
                io::ErrorKind::NotADirectory,
                "managed Hmux cwd must be a directory",
            ));
        }
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
            ) => error,
        Err(error) => return Err(error),
    };

    if let Some(repository) = recorded
        .is_absolute()
        .then(|| nearest_repository_root(recorded))
        .flatten()
    {
        return Ok(repository);
    }
    if let Some(home) = dirs::home_dir()
        .and_then(|home| std::fs::canonicalize(home).ok())
        .filter(|home| home.is_dir())
    {
        return Ok(home);
    }
    Err(missing)
}
