//! Editing `~/.ssh/authorized_keys` without breaking anyone else's access.
//!
//! This is a destructive edit to a file that other things depend on, so the
//! byte model is stated explicitly rather than left to `OpenOptions::append`.
//!
//! The specific failure this exists to prevent: an `authorized_keys` whose last
//! line has no trailing newline. A naive append concatenates the new entry onto
//! the tail of somebody's existing key, producing one corrupt line where there
//! were two valid ones — and the visible symptom is that *their* key silently
//! stops working, not that ours failed. So the rule here is stronger than "add
//! a newline if needed": **the original bytes must remain a byte-for-byte
//! prefix of the result.** Anything else is a rewrite of lines we did not add.
//!
//! Why a temp-file rename rather than an in-place `write_all`: a crash or a
//! full disk halfway through an in-place write leaves a truncated
//! `authorized_keys`, which locks the owner out of their own server. A rename
//! is atomic on both APFS and every Linux filesystem we target, so the file is
//! either the old one or the new one.
//!
//! Why the sidecar lock rather than locking `authorized_keys` itself: the
//! rename replaces the inode, so a lock held on the target would be dropped by
//! our own success and would not exclude a second `hmux pair` racing us. The
//! lock has to live on something we never replace.

use fs2::FileExt as _;
use std::fs::{File, OpenOptions};
use std::io::{self, Read as _, Write as _};
use std::path::{Path, PathBuf};

/// Name of the lock file placed beside `authorized_keys`.
const LOCK_FILE_NAME: &str = ".hmux-pairing.lock";

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum AppendOutcome {
    /// The exact entry is already on file; nothing was written.
    AlreadyPresent,
    /// The bytes the file should now hold. The input is a prefix of these.
    Appended(Vec<u8>),
}

/// Appends `entry` as its own line, leaving every pre-existing byte untouched.
///
/// `entry` must be a single line with no terminator; callers get that from
/// [`super::entry::AuthorizedKeyEntry`], which refuses embedded newlines.
pub(crate) fn append_entry(existing: &[u8], entry: &str) -> AppendOutcome {
    if contains_entry(existing, entry) {
        return AppendOutcome::AlreadyPresent;
    }
    let mut appended = Vec::with_capacity(existing.len() + entry.len() + 2);
    appended.extend_from_slice(existing);
    // The separator is added rather than the tail rewritten: a file that ends
    // mid-line keeps that line intact and gains a terminator, so the reader
    // sees two lines where it previously saw one truncated one.
    if !appended.is_empty() && !appended.ends_with(b"\n") {
        appended.push(b'\n');
    }
    appended.extend_from_slice(entry.as_bytes());
    appended.push(b'\n');
    AppendOutcome::Appended(appended)
}

/// Drops every line byte-equal to `entry`, leaving all other lines in order.
///
/// Returns `None` when the entry was not present, so a caller can tell "already
/// revoked" from "revoked now" instead of reporting a no-op as a success.
pub(crate) fn remove_entry(existing: &[u8], entry: &str) -> Option<Vec<u8>> {
    let mut kept: Vec<u8> = Vec::with_capacity(existing.len());
    let mut removed = false;
    for line in terminated_lines(existing) {
        if line_content(line) == entry.as_bytes() {
            removed = true;
            continue;
        }
        kept.extend_from_slice(line);
    }
    removed.then_some(kept)
}

fn contains_entry(existing: &[u8], entry: &str) -> bool {
    terminated_lines(existing).any(|line| line_content(line) == entry.as_bytes())
}

/// Splits into lines that still carry their own terminator, so reassembling by
/// concatenation reproduces the input exactly — including a final line with no
/// newline, which is the case this module exists for.
fn terminated_lines(bytes: &[u8]) -> impl Iterator<Item = &[u8]> {
    let mut rest = bytes;
    std::iter::from_fn(move || {
        if rest.is_empty() {
            return None;
        }
        let end = rest
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(rest.len(), |index| index + 1);
        let (line, remainder) = rest.split_at(end);
        rest = remainder;
        Some(line)
    })
}

fn line_content(line: &[u8]) -> &[u8] {
    let without_newline = line.strip_suffix(b"\n").unwrap_or(line);
    without_newline
        .strip_suffix(b"\r")
        .unwrap_or(without_newline)
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum AppliedChange {
    Written,
    AlreadyPresent,
}

/// Where a home directory's `authorized_keys` lives, and how to edit it safely.
pub(crate) struct AuthorizedKeysFile {
    path: PathBuf,
}

impl AuthorizedKeysFile {
    pub(crate) fn in_home(home: &Path) -> Self {
        Self {
            path: home.join(".ssh").join("authorized_keys"),
        }
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    /// Appends `entry` under an exclusive lock, atomically, preserving mode.
    pub(crate) fn append(&self, entry: &str) -> io::Result<AppliedChange> {
        let directory = self.ssh_directory()?;
        let _lock = DirectoryLock::acquire(&directory)?;
        let existing = read_optional(&self.path)?;
        match append_entry(&existing, entry) {
            AppendOutcome::AlreadyPresent => Ok(AppliedChange::AlreadyPresent),
            AppendOutcome::Appended(contents) => {
                self.replace_contents(&directory, &contents)?;
                Ok(AppliedChange::Written)
            }
        }
    }

    /// Removes `entry` under the same lock and the same atomicity.
    pub(crate) fn remove(&self, entry: &str) -> io::Result<AppliedChange> {
        let directory = self.ssh_directory()?;
        let _lock = DirectoryLock::acquire(&directory)?;
        let existing = read_optional(&self.path)?;
        match remove_entry(&existing, entry) {
            None => Ok(AppliedChange::AlreadyPresent),
            Some(contents) => {
                self.replace_contents(&directory, &contents)?;
                Ok(AppliedChange::Written)
            }
        }
    }

    fn ssh_directory(&self) -> io::Result<PathBuf> {
        let directory = self
            .path
            .parent()
            .ok_or_else(|| io::Error::other("authorized_keys path has no parent directory"))?
            .to_path_buf();
        std::fs::create_dir_all(&directory)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            // sshd refuses a group- or world-writable ~/.ssh outright, so a
            // directory we had to create must arrive already narrow rather than
            // inheriting whatever umask the operator happens to run.
            let mode = std::fs::metadata(&directory)?.permissions().mode();
            if mode & 0o077 != 0 {
                std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))?;
            }
        }
        Ok(directory)
    }

    fn replace_contents(&self, directory: &Path, contents: &[u8]) -> io::Result<()> {
        let temporary = directory.join(format!(".hmux-authorized_keys.{}", std::process::id()));
        // Fresh file every time: an inherited one could be a symlink an
        // attacker planted, and `create_new` turns that into a refusal.
        let _ = std::fs::remove_file(&temporary);
        let mut handle = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(&self.path)
                .map(|metadata| metadata.permissions().mode() & 0o7777)
                .unwrap_or(0o600);
            handle.set_permissions(std::fs::Permissions::from_mode(mode))?;
        }
        let write = handle
            .write_all(contents)
            .and_then(|()| handle.sync_all())
            .and_then(|()| std::fs::rename(&temporary, &self.path));
        if write.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        write
    }
}

fn read_optional(path: &Path) -> io::Result<Vec<u8>> {
    match File::open(path) {
        Ok(mut file) => {
            let mut contents = Vec::new();
            file.read_to_end(&mut contents)?;
            Ok(contents)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error),
    }
}

struct DirectoryLock(File);

impl DirectoryLock {
    fn acquire(directory: &Path) -> io::Result<Self> {
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(directory.join(LOCK_FILE_NAME))?;
        file.lock_exclusive()?;
        Ok(Self(file))
    }
}

impl Drop for DirectoryLock {
    fn drop(&mut self) {
        let _ = fs2::FileExt::unlock(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ENTRY: &str = "restrict,command=\"hmux mobile-gateway\" ssh-ed25519 AAAAC3Nz phone";

    #[test]
    fn appending_to_a_file_without_a_trailing_newline_keeps_every_original_byte() {
        let existing = b"ssh-ed25519 AAAAsomebodyelse laptop\nssh-rsa AAAAB3 no-newline-here";
        let AppendOutcome::Appended(result) = append_entry(existing, ENTRY) else {
            panic!("a file missing the entry must be appended to");
        };
        assert!(
            result.starts_with(existing),
            "the original bytes must survive verbatim, got {:?}",
            String::from_utf8_lossy(&result)
        );
        let lines: Vec<&[u8]> = result.split(|byte| *byte == b'\n').collect();
        assert_eq!(lines[1], b"ssh-rsa AAAAB3 no-newline-here");
        assert_eq!(lines[2], ENTRY.as_bytes());
    }

    #[test]
    fn appending_to_an_empty_file_does_not_open_with_a_blank_line() {
        let AppendOutcome::Appended(result) = append_entry(b"", ENTRY) else {
            panic!("an empty file must be appended to");
        };
        assert_eq!(result, format!("{ENTRY}\n").into_bytes());
    }

    #[test]
    fn an_entry_already_on_file_is_not_appended_twice() {
        let existing = format!("ssh-rsa AAAAB3 other\n{ENTRY}\n").into_bytes();
        assert_eq!(
            append_entry(&existing, ENTRY),
            AppendOutcome::AlreadyPresent
        );
    }

    #[test]
    fn removing_an_entry_leaves_the_other_lines_in_order() {
        let existing = format!("first AAAA a\n{ENTRY}\nlast AAAA b\n").into_bytes();
        let removed = remove_entry(&existing, ENTRY).expect("the entry was present");
        assert_eq!(removed, b"first AAAA a\nlast AAAA b\n");
    }

    #[test]
    fn removing_an_absent_entry_reports_absence_rather_than_rewriting() {
        assert!(remove_entry(b"first AAAA a\n", ENTRY).is_none());
    }

    #[test]
    fn a_file_edited_on_disk_keeps_its_mode_and_its_original_prefix() {
        let home = tempfile::tempdir().unwrap();
        let file = AuthorizedKeysFile::in_home(home.path());
        std::fs::create_dir_all(file.path().parent().unwrap()).unwrap();
        let existing = b"ssh-ed25519 AAAAoriginal desk".to_vec();
        std::fs::write(file.path(), &existing).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(file.path(), std::fs::Permissions::from_mode(0o640)).unwrap();
        }

        assert_eq!(file.append(ENTRY).unwrap(), AppliedChange::Written);
        assert_eq!(file.append(ENTRY).unwrap(), AppliedChange::AlreadyPresent);

        let after = std::fs::read(file.path()).unwrap();
        assert!(after.starts_with(&existing));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(file.path()).unwrap().permissions().mode() & 0o7777;
            assert_eq!(mode, 0o640, "the pre-existing file mode must survive");
        }
    }
}
