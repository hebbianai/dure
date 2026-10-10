//! Repository-local exclusions shared by interactive and scheduled worktrees.
use super::*;

/// Ignore a generated directory inside this checkout, without modifying tracked
/// ignore files or the index. External worktrees require no exclusion.
pub fn exclude_worktree_directory(
    repository: &Path,
    directory: &Path,
) -> Result<(), GitCheckoutInstanceError> {
    let location = locate_checkout(repository)?;
    let directory = if directory.exists() {
        canonical(directory, "worktree directory")?
    } else {
        let parent = directory
            .parent()
            .ok_or_else(|| failure("missing parent"))?;
        canonical(parent, "worktree parent")?.join(
            directory
                .file_name()
                .ok_or_else(|| failure("missing directory name"))?,
        )
    };
    let Ok(relative) = directory.strip_prefix(&location.canonical_path) else {
        return Ok(());
    };
    if relative.as_os_str().is_empty() {
        return Err(failure("cannot exclude the checkout root"));
    }
    let mut entry = String::from("/");
    for component in relative.components() {
        let text = component
            .as_os_str()
            .to_str()
            .ok_or_else(|| failure("non-UTF-8 path"))?;
        for ch in text.chars() {
            if ch.is_control() {
                return Err(failure("unsupported path character"));
            }
            if matches!(ch, '\\' | '*' | '?' | '[' | ']' | ' ' | '#' | '!') {
                entry.push('\\');
            }
            entry.push(ch);
        }
        entry.push('/');
    }
    let exclude = PathBuf::from(git_line(
        repository,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "info/exclude",
        ],
    )?);
    let parent = exclude
        .parent()
        .ok_or_else(|| failure("missing exclude parent"))?;
    std::fs::create_dir_all(parent).map_err(failure)?;
    let mut options = OpenOptions::new();
    options.create(true).read(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut file = options.open(&exclude).map_err(failure)?;
    if !file.metadata().map_err(failure)?.is_file() {
        return Err(failure("exclude is not a regular file"));
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        match file.try_lock_exclusive() {
            Ok(()) => break,
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    && std::time::Instant::now() < deadline =>
            {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            Err(error) => return Err(failure(error)),
        }
    }
    let mut existing = Vec::new();
    (&file)
        .take(1_048_577)
        .read_to_end(&mut existing)
        .map_err(failure)?;
    if existing.len() > 1_048_576 {
        return Err(failure("exclude exceeds 1 MiB"));
    }
    if existing
        .split(|byte| *byte == b'\n')
        .any(|line| line.strip_suffix(b"\r").unwrap_or(line) == entry.as_bytes())
    {
        return Ok(());
    }
    let prefix = if existing.is_empty() || existing.ends_with(b"\n") {
        ""
    } else {
        "\n"
    };
    file.write_all(format!("{prefix}{entry}\n").as_bytes())
        .map_err(failure)?;
    file.sync_all().map_err(failure)
}

fn failure(detail: impl std::fmt::Display) -> GitCheckoutInstanceError {
    error(
        "worktree_exclude_unavailable",
        "could not exclude the generated worktree",
        detail,
    )
}

#[cfg(test)]
mod tests;
