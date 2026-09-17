use std::path::Path;

use base64::Engine;
use serde::Serialize;
use ssh2::Sftp;

use super::{acquire, exec_on, shell_quote, SshOptions};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_repo: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryListing {
    pub path: String,
    pub entries: Vec<DirectoryEntry>,
    pub is_repo: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDirectory {
    pub path: String,
    pub is_repo: bool,
    pub origin: Option<String>,
}

fn windows_drive(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 2
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes.len() == 2 || matches!(bytes[2], b'/' | b'\\'))
}

/// SFTP paths belong to the remote namespace, never the local OS path parser.
fn normalize_path(path: &str) -> String {
    let path = path
        .strip_prefix('/')
        .filter(|rest| windows_drive(rest))
        .unwrap_or(path);
    if windows_drive(path) {
        let path = path.replace('\\', "/");
        if path.len() == 2 {
            format!("{path}/")
        } else {
            path
        }
    } else {
        path.to_owned()
    }
}

fn join_path(parent: &str, name: &str) -> String {
    format!(
        "{}{name}",
        if parent.ends_with('/') {
            parent.to_owned()
        } else {
            format!("{parent}/")
        }
    )
}

fn resolve(sftp: &Sftp, path: Option<&str>) -> Result<String, String> {
    let requested = path.unwrap_or(".");
    if requested.len() > 32_768 || requested.contains('\0') {
        return Err("Invalid remote directory path".into());
    }
    let requested = normalize_path(requested);
    let requested = if requested == "~" || requested.starts_with("~/") {
        let home = sftp
            .realpath(Path::new("."))
            .map_err(|e| format!("Resolve remote home: {e}"))?;
        join_path(
            &home.to_string_lossy(),
            requested.strip_prefix("~/").unwrap_or(""),
        )
    } else {
        requested
    };
    let path = sftp
        .realpath(Path::new(&requested))
        .map_err(|e| format!("Resolve remote directory: {e}"))?;
    let path = normalize_path(&path.to_string_lossy());
    if !sftp
        .stat(Path::new(&path))
        .map_err(|e| format!("Read remote directory: {e}"))?
        .is_dir()
    {
        return Err("Remote path is not a directory".into());
    }
    Ok(path)
}

pub fn browse(opts: &SshOptions, path: Option<&str>) -> Result<DirectoryListing, String> {
    let session = acquire(opts)?;
    let sftp = session.sftp().map_err(|e| format!("Open SFTP: {e}"))?;
    let path = resolve(&sftp, path)?;
    // Read names separately from local Path components: a POSIX filename may
    // contain backslashes even when the desktop running this adapter is Windows.
    let mut directory = sftp
        .opendir(Path::new(&path))
        .map_err(|e| format!("List remote directory: {e}"))?;
    let mut entries = Vec::new();
    let mut is_repo = false;
    loop {
        let (name, stat) = match directory.readdir() {
            Ok(entry) => entry,
            Err(e) if e.code() == ssh2::ErrorCode::Session(-16) => break,
            Err(e) => return Err(format!("List remote directory: {e}")),
        };
        let name = name
            .to_str()
            .ok_or("Remote filename is not UTF-8")?
            .to_owned();
        if name == "." || name == ".." {
            continue;
        }
        if entries.len() >= 100_000 {
            return Err("Remote directory contains too many entries".into());
        }
        let entry_path = join_path(&path, &name);
        let is_dir = stat.is_dir()
            || (stat.file_type().is_symlink()
                && sftp
                    .stat(Path::new(&entry_path))
                    .is_ok_and(|target| target.is_dir()));
        is_repo |= name == ".git";
        entries.push(DirectoryEntry {
            name,
            path: entry_path,
            is_dir,
            is_repo: false,
        });
    }
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    Ok(DirectoryListing {
        path,
        entries,
        is_repo,
    })
}

/// Git is a process concern. Select its interpreter from the resolved remote
/// path; never change the server's default shell or depend on the desktop OS.
fn project_command(path: &str) -> String {
    if windows_drive(path) {
        let literal = format!("'{}'", path.replace('\'', "''"));
        let script = format!(
            "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); \
             $p = {literal}; \
             if (!(Get-Command git -ErrorAction SilentlyContinue)) {{ Write-Output 'false'; exit 0 }}; \
             $inside = & git -C $p rev-parse --is-inside-work-tree 2>$null; \
             if ($LASTEXITCODE -ne 0 -or $inside -ne 'true') {{ Write-Output 'false'; exit 0 }}; \
             Write-Output 'true'; & git -C $p remote get-url origin 2>$null; exit 0"
        );
        let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
        format!(
            "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand {}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )
    } else {
        let literal = shell_quote(path);
        let script = format!("if [ \"$(git -C {literal} rev-parse --is-inside-work-tree 2>/dev/null)\" = true ]; then printf 'true\\n'; git -C {literal} remote get-url origin 2>/dev/null || :; else printf 'false\\n'; fi");
        format!("sh -c {}", shell_quote(&script))
    }
}

pub fn project(opts: &SshOptions, path: &str) -> Result<ProjectDirectory, String> {
    let session = acquire(opts)?;
    let sftp = session.sftp().map_err(|e| format!("Open SFTP: {e}"))?;
    let path = resolve(&sftp, Some(path))?;
    let result = exec_on(&session, &project_command(&path))?;
    if result.code != 0 {
        return Err(format!(
            "Read remote project (exit {}): {}",
            result.code,
            result.stderr.trim()
        ));
    }
    let mut lines = result.stdout.lines();
    let is_repo = match lines.next().map(str::trim) {
        Some("true") => true,
        Some("false") => false,
        _ => return Err("Invalid remote project response".into()),
    };
    let origin = lines
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_owned);
    Ok(ProjectDirectory {
        path,
        is_repo,
        origin,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_paths_do_not_depend_on_the_desktop_platform() {
        assert_eq!(normalize_path(r"C:\Users\dev\한 글"), "C:/Users/dev/한 글");
        assert_eq!(normalize_path("/D:/"), "D:/");
        assert_eq!(normalize_path("D:"), "D:/");
        assert_eq!(normalize_path(r"/home/a\b"), r"/home/a\b");
        assert_eq!(join_path("C:/", "project"), "C:/project");
        assert_eq!(join_path("/", "project"), "/project");
    }

    #[test]
    fn windows_project_command_keeps_paths_outside_the_outer_shell() {
        let command = project_command("C:/Users/dev/a' & $b 한글");
        let encoded = command.split_whitespace().last().unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        let words: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|b| u16::from_le_bytes([b[0], b[1]]))
            .collect();
        let script = String::from_utf16(&words).unwrap();
        assert!(script.contains("$p = 'C:/Users/dev/a'' & $b 한글'"));
        assert!(!command.contains("$b"));
    }
}
