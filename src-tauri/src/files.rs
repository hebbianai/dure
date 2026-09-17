use base64::Engine;
use serde::Serialize;

pub(crate) const MAX_FILE_BYTES: u64 = 25 * 1024 * 1024;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub name: String,
    pub path: String,
    /// "text" | "markdown" | "image" | "pdf" | "video" | "binary"
    pub kind: String,
    /// text면 utf8 문자열, 그 외(image/pdf/binary)면 base64
    pub content: String,
    pub size: u64,
    /// image/pdf의 MIME (data: URI 조립용)
    pub mime: Option<String>,
    pub truncated: bool,
}

/// 확장자로 표시 종류/MIME 판별. 텍스트 계열은 폭넓게 text로.
pub fn classify(name: &str) -> (&'static str, Option<&'static str>) {
    let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "md" | "markdown" | "mdx" => ("markdown", None),
        "png" => ("image", Some("image/png")),
        "jpg" | "jpeg" => ("image", Some("image/jpeg")),
        "gif" => ("image", Some("image/gif")),
        "webp" => ("image", Some("image/webp")),
        "svg" => ("image", Some("image/svg+xml")),
        "bmp" => ("image", Some("image/bmp")),
        "ico" => ("image", Some("image/x-icon")),
        "pdf" => ("pdf", Some("application/pdf")),
        // WebKit이 재생할 수 있는 영상만 video로 분류한다. mkv/avi 등 재생 불가
        // 컨테이너는 binary로 남아 뷰어의 "기본 앱으로 열기"로 안내된다.
        "webm" => ("video", Some("video/webm")),
        "mp4" | "m4v" => ("video", Some("video/mp4")),
        "mov" => ("video", Some("video/quicktime")),
        // 바이너리로 취급할 확장자
        "zip" | "tar" | "gz" | "bz2" | "xz" | "7z" | "rar" | "exe" | "dll" | "so" | "dylib"
        | "o" | "a" | "class" | "wasm" | "bin" | "dat" | "db" | "sqlite" | "woff" | "woff2"
        | "ttf" | "otf" | "eot" | "mp3" | "avi" | "mkv" | "wav" | "flac" => {
            ("binary", None)
        }
        _ => ("text", None),
    }
}

/// Folder admission is independent of Git availability and never scans entries.
#[tauri::command(async)]
pub fn inspect_local_directory(path: String) -> Result<String, String> {
    let directory = std::path::Path::new(&path);
    if !directory.is_absolute() {
        return Err(format!("{path}: an absolute directory path is required"));
    }
    let metadata = std::fs::metadata(directory).map_err(|error| format!("{path}: {error}"))?;
    if !metadata.is_dir() {
        return Err(format!("{path}: not a directory"));
    }
    std::fs::canonicalize(directory)
        .map_err(|error| format!("{path}: {error}"))?
        .into_os_string()
        .into_string()
        .map_err(|_| format!("{path}: directory path is not UTF-8"))
}

pub fn read_local(path: &str) -> Result<FileContent, String> {
    let p = std::path::Path::new(path);
    let meta = std::fs::metadata(p).map_err(|e| format!("{path}: {e}"))?;
    if meta.is_dir() {
        return Err("The path is a directory".into());
    }
    let size = meta.len();
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());
    let (kind, mime) = classify(&name);

    let read_len = size.min(MAX_FILE_BYTES) as usize;
    let bytes = read_capped(p, read_len)?;
    let truncated = size > MAX_FILE_BYTES;

    let content = if kind == "text" || kind == "markdown" {
        String::from_utf8_lossy(&bytes).into_owned()
    } else {
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    };

    Ok(FileContent {
        name,
        path: path.to_string(),
        kind: kind.to_string(),
        content,
        size,
        mime: mime.map(str::to_string),
        truncated,
    })
}

/// 로컬 텍스트 파일 저장. 같은 디렉토리에 임시 파일을 쓰고 rename 해 부분 기록을
/// 남기지 않는다(에이전트가 동시에 읽어도 반쪽 파일을 보지 않도록).
pub fn write_local(path: &str, content: &str) -> Result<u64, String> {
    use std::io::Write;
    let p = std::path::Path::new(path);
    if p.is_dir() {
        return Err("The path is a directory".into());
    }
    let dir = p.parent().ok_or("Could not determine the parent directory")?;
    if !dir.exists() {
        return Err(format!("{}: directory does not exist", dir.display()));
    }
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into());
    let tmp = dir.join(format!(".{name}.agent-ide.tmp"));

    let bytes = content.as_bytes();
    let write_result = (|| -> Result<(), String> {
        let mut f = std::fs::File::create(&tmp).map_err(|e| format!("{}: {e}", tmp.display()))?;
        f.write_all(bytes).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
        Ok(())
    })();
    if let Err(e) = write_result {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }

    // 원본 권한 유지 (신규 파일이면 기본 권한 그대로).
    if let Ok(meta) = std::fs::metadata(p) {
        let _ = std::fs::set_permissions(&tmp, meta.permissions());
    }
    if let Err(e) = std::fs::rename(&tmp, p) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("{path}: {e}"));
    }
    Ok(bytes.len() as u64)
}

/// SSH: 텍스트를 base64로 인코딩해 원격에 저장. 인자 길이 상한(ARG_MAX)에 걸리지
/// 않도록 청크로 나눠 임시 파일에 append 한 뒤 디코드해 mv 한다.
pub fn write_remote(
    exec: impl Fn(&str) -> Result<String, String>,
    path: &str,
    content: &str,
) -> Result<u64, String> {
    let quoted = quote_remote(path);
    let bytes = content.as_bytes();
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);

    // 임시 경로도 같은 셸 확장 규칙을 따라야 한다(~/ 처리).
    let tmp_quoted = quote_remote(&format!("{path}.agent-ide.tmp"));

    // 첫 청크는 > 로 잘라내고, 이후 >> 로 이어붙인다.
    const CHUNK: usize = 60_000;
    let mut first = true;
    for chunk in b64.as_bytes().chunks(CHUNK) {
        let part = std::str::from_utf8(chunk).map_err(|e| e.to_string())?;
        let redir = if first { ">" } else { ">>" };
        first = false;
        exec(&format!("printf '%s' '{part}' {redir} {tmp_quoted}.b64"))?;
    }
    if first {
        // 빈 파일
        exec(&format!("printf '' > {tmp_quoted}.b64"))?;
    }

    // 디코드 → 원자적 교체. 실패하면 임시 파일을 남기지 않는다.
    let cmd = format!(
        "base64 -d < {tmp_quoted}.b64 > {tmp_quoted} && mv {tmp_quoted} {quoted} && rm -f {tmp_quoted}.b64 && echo ok || {{ rm -f {tmp_quoted} {tmp_quoted}.b64; echo fail; }}"
    );
    let out = exec(&cmd)?;
    if !out.contains("ok") {
        return Err("Could not save the remote file".into());
    }
    Ok(bytes.len() as u64)
}

const REMOTE_DELETE_OK: &str = "__DURE_REMOTE_DELETE_OK_V1__";

#[derive(Debug, PartialEq, Eq)]
enum RemotePathRoot {
    Absolute,
    Home,
}

/// 삭제 대상은 Files pane이 연 workspace root의 엄격한 하위 항목만 허용한다.
/// 셸에서 정규화하기 전에 한 번 거르는 fail-closed 경계라 상대 경로와 `..`는
/// 의도적으로 지원하지 않는다. Files 목록이 만드는 경로는 절대 경로 또는 `~/`다.
fn remote_path_parts(path: &str) -> Result<(RemotePathRoot, Vec<&str>), String> {
    if path.is_empty() || path.contains(['\0', '\n', '\r']) {
        return Err("Unsafe remote path".into());
    }
    let (root, rest) = if path == "~" {
        (RemotePathRoot::Home, "")
    } else if let Some(rest) = path.strip_prefix("~/") {
        (RemotePathRoot::Home, rest)
    } else if let Some(rest) = path.strip_prefix('/') {
        (RemotePathRoot::Absolute, rest)
    } else {
        return Err("Remote deletion requires an absolute path".into());
    };
    let mut parts = Vec::new();
    for part in rest.split('/') {
        if part.is_empty() {
            continue;
        }
        if part == "." || part == ".." {
            return Err("Remote deletion paths cannot contain . or ..".into());
        }
        parts.push(part);
    }
    Ok((root, parts))
}

fn remote_parent(path: &str) -> Result<(&str, &str), String> {
    if path.ends_with('/') {
        return Err("The remote deletion target must identify an item".into());
    }
    let (parent, name) = path
        .rsplit_once('/')
        .ok_or_else(|| "The remote deletion target has no parent path".to_string())?;
    if name.is_empty() || name == "." || name == ".." {
        return Err("Unsafe remote deletion target".into());
    }
    let parent = if parent.is_empty() { "/" } else { parent };
    Ok((parent, name))
}

/// SSH Files 영구 삭제. 원격 휴지통은 provider마다 계약이 달라 거짓 Undo를
/// 제공하지 않고, 확인된 workspace root 아래의 정확한 항목만 제거한다.
///
/// 부모를 원격에서 `pwd -P`로 다시 확인한 뒤 그 물리 경로와 basename을 조합한다.
/// 따라서 workspace 밖을 가리키는 symlink 디렉터리를 통해 `rm -rf`가 나가지
/// 않는다. 대상 자체가 symlink면 링크만 제거한다.
pub fn delete_remote(
    exec: impl Fn(&str) -> Result<String, String>,
    root: &str,
    path: &str,
    is_directory: bool,
) -> Result<(), String> {
    let (root_kind, root_parts) = remote_path_parts(root)?;
    let (path_kind, path_parts) = remote_path_parts(path)?;
    if root_kind != path_kind
        || path_parts.len() <= root_parts.len()
        || !path_parts.starts_with(&root_parts)
    {
        return Err("Cannot delete the workspace root or items outside it".into());
    }

    let (parent, name) = remote_parent(path)?;
    let trimmed_root = root.trim_end_matches('/');
    let normalized_root = if trimmed_root.is_empty() { "/" } else { trimmed_root };
    let root_quoted = quote_remote(normalized_root);
    let parent_quoted = quote_remote(parent);
    let name_quoted = quote_shell_word(name);
    let remove = if is_directory {
        // 디렉터리 symlink는 재귀로 따라가지 않고 링크 하나만 지운다.
        "if [ -L \"$candidate\" ]; then rm -f -- \"$candidate\"; elif [ -d \"$candidate\" ]; then rm -rf -- \"$candidate\"; else exit 45; fi"
    } else {
        "if [ -d \"$candidate\" ] && [ ! -L \"$candidate\" ]; then exit 45; else rm -f -- \"$candidate\"; fi"
    };
    let command = format!(
        "root_real=$(cd {root_quoted} 2>/dev/null && pwd -P) || exit 41; \
         parent_real=$(cd {parent_quoted} 2>/dev/null && pwd -P) || exit 42; \
         if [ \"$root_real\" != / ]; then case \"$parent_real/\" in \"$root_real/\"*) ;; *) exit 43 ;; esac; fi; \
         candidate=\"$parent_real\"/{name_quoted}; \
         if [ ! -e \"$candidate\" ] && [ ! -L \"$candidate\" ]; then exit 44; fi; \
         {remove} && printf '%s\\n' {REMOTE_DELETE_OK}"
    );
    let output = exec(&command)?;
    if !output.lines().any(|line| line.trim() == REMOTE_DELETE_OK) {
        return Err("Could not delete the remote item".into());
    }
    Ok(())
}

/// 원격 셸 인용: 선두 `~/`는 셸이 확장하도록 따옴표 밖에 둔다.
fn quote_remote(path: &str) -> String {
    if path == "~" {
        "~".into()
    } else if let Some(rest) = path.strip_prefix("~/") {
        format!("~/'{}'", rest.replace('\'', "'\\''"))
    } else {
        quote_shell_word(path)
    }
}

fn quote_shell_word(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

// ---------------------------------------------------------------------------
// 파일 참조 해석 — 에이전트가 디렉토리 없이 이름만 말한 경우의 폴백
// ---------------------------------------------------------------------------
//
// 에이전트 출력에는 "TerminalView.tsx:952" 처럼 basename만 나오는 일이 잦다.
// 그대로 cwd 아래로 붙이면 없는 경로가 되므로, 읽기가 실패했을 때 저장소에서
// 같은 이름의 파일을 찾아 후보로 돌려준다.

/// 실패한 절대 경로에서 저장소 루트를 거슬러 찾는다. 없으면 그 디렉토리.
fn repo_root_of(path: &std::path::Path) -> std::path::PathBuf {
    let start = path.parent().unwrap_or(std::path::Path::new("/"));
    let mut cur = Some(start);
    while let Some(d) = cur {
        if d.join(".git").exists() {
            return d.to_path_buf();
        }
        cur = d.parent();
    }
    start.to_path_buf()
}

/// 후보를 "뒤에서부터 몇 개 구간이 일치하는지"로 정렬한다.
/// 예: 찾는 게 `a/b/X.ts`면 `p/a/b/X.ts`가 `q/b/X.ts`보다 앞선다.
/// 같은 점수면 경로가 짧은 쪽(대개 얕고 주된 위치)이 앞.
fn rank_candidates(wanted_rel: &str, mut found: Vec<String>, limit: usize) -> Vec<String> {
    let wanted: Vec<&str> = wanted_rel.split('/').filter(|s| !s.is_empty()).collect();
    let depth = |cand: &str| -> usize {
        let segs: Vec<&str> = cand.split('/').filter(|s| !s.is_empty()).collect();
        let mut n = 0;
        while n < wanted.len()
            && n < segs.len()
            && wanted[wanted.len() - 1 - n] == segs[segs.len() - 1 - n]
        {
            n += 1;
        }
        n
    };
    found.sort_by(|a, b| {
        depth(b)
            .cmp(&depth(a))
            .then_with(|| a.len().cmp(&b.len()))
            .then_with(|| a.cmp(b))
    });
    found.truncate(limit);
    found
}

/// 로컬: 저장소에서 같은 이름의 파일을 찾는다. 절대 경로 목록을 돌려준다.
pub fn find_local_candidates(missing_path: &str, limit: usize) -> Vec<String> {
    let p = std::path::Path::new(missing_path);
    let Some(name) = p.file_name().map(|n| n.to_string_lossy().into_owned()) else {
        return Vec::new();
    };
    let root = repo_root_of(p);
    let wanted_rel = p
        .strip_prefix(&root)
        .map(|r| r.to_string_lossy().into_owned())
        .unwrap_or_else(|_| name.clone());

    // git ls-files는 빠르고 .gitignore를 따른다(node_modules/target 제외).
    // 저장소가 아니면 깊이 제한 순회로 대체한다.
    let listed = std::process::Command::new("git")
        .arg("-C")
        .arg(&root)
        .arg("ls-files")
        .arg("-z")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .split('\0')
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        });

    let rels = match listed {
        Some(v) => v,
        None => walk_for_name(&root, &name, 6, limit * 8),
    };

    let matching: Vec<String> = rels
        .into_iter()
        .filter(|rel| rel.rsplit('/').next().unwrap_or(rel) == name)
        .collect();

    rank_candidates(&wanted_rel, matching, limit)
        .into_iter()
        .map(|rel| root.join(rel).to_string_lossy().into_owned())
        .collect()
}

/// git 저장소가 아닐 때의 폴백 — 깊이/개수를 제한한 순회.
fn walk_for_name(root: &std::path::Path, name: &str, max_depth: usize, cap: usize) -> Vec<String> {
    const SKIP: [&str; 7] = [".git", "node_modules", "target", "dist", "build", ".next", "out"];
    let mut found = Vec::new();
    let mut queue = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = queue.pop() {
        if depth > max_depth || found.len() >= cap {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let file_name = entry.file_name();
            let file_name = file_name.to_string_lossy();
            if file_name.starts_with('.') && file_name != ".git" {
                continue;
            }
            let path = entry.path();
            if path.is_dir() {
                if !SKIP.contains(&file_name.as_ref()) {
                    queue.push((path, depth + 1));
                }
            } else if file_name == name {
                if let Ok(rel) = path.strip_prefix(root) {
                    found.push(rel.to_string_lossy().into_owned());
                }
            }
        }
    }
    found
}

/// SSH: 같은 판정을 원격에서 한다. basename으로 먼저 걸러 전송량을 줄인다.
pub fn find_remote_candidates(
    exec: impl Fn(&str) -> Result<String, String>,
    missing_path: &str,
    limit: usize,
) -> Vec<String> {
    let name = missing_path.rsplit('/').next().unwrap_or(missing_path);
    if name.is_empty() {
        return Vec::new();
    }
    let dir = match missing_path.rfind('/') {
        Some(i) if i > 0 => &missing_path[..i],
        _ => "/",
    };
    // 루트를 구하고, 저장소면 ls-files, 아니면 제한된 find로 목록을 만든다.
    let cmd = format!(
        "d={}; root=$(cd \"$d\" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null); \
         [ -n \"$root\" ] || root=$d; cd \"$root\" 2>/dev/null || exit 0; echo \"$root\"; \
         {{ git ls-files 2>/dev/null || find . -maxdepth 7 -type f -not -path '*/.git/*' -not -path '*/node_modules/*' 2>/dev/null | sed 's|^\\./||'; }} \
         | grep -F {} | head -400",
        quote_remote(dir),
        quote_remote(name),
    );
    let Ok(out) = exec(&cmd) else {
        return Vec::new();
    };
    let mut lines = out.lines();
    let Some(root) = lines.next().map(str::trim).filter(|r| !r.is_empty()) else {
        return Vec::new();
    };
    let wanted_rel = missing_path.strip_prefix(&format!("{root}/")).unwrap_or(name);
    let matching: Vec<String> = lines
        .map(str::trim)
        .filter(|rel| !rel.is_empty() && rel.rsplit('/').next().unwrap_or(rel) == name)
        .map(str::to_string)
        .collect();

    rank_candidates(wanted_rel, matching, limit)
        .into_iter()
        .map(|rel| format!("{}/{}", root.trim_end_matches('/'), rel))
        .collect()
}

fn read_capped(p: &std::path::Path, len: usize) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let mut f = std::fs::File::open(p).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; len];
    let mut filled = 0;
    while filled < len {
        let n = f.read(&mut buf[filled..]).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    buf.truncate(filled);
    Ok(buf)
}

/// SSH: 원격 파일을 base64로 받아 동일 구조로 반환. 크기 확인 후 상한까지만.
pub fn read_remote(exec: impl Fn(&str) -> Result<String, String>, path: &str) -> Result<FileContent, String> {
    // 원격 셸 인용: 선두 `~/`는 셸이 확장하도록 따옴표 밖에 두고 나머지만
    // 단일 인용 (예: ~/'a b'.md → /home/user/a b.md). 공백/특수문자 안전.
    let quoted = quote_remote(path);
    let size_out = exec(&format!("wc -c < {quoted} 2>/dev/null || echo -1"))?;
    let size: i64 = size_out.trim().parse().unwrap_or(-1);
    if size < 0 {
        return Err("Could not read the file".into());
    }
    let size = size as u64;
    let name = path.rsplit('/').next().unwrap_or(path).to_string();
    let (kind, mime) = classify(&name);
    let truncated = size > MAX_FILE_BYTES;
    let cap = MAX_FILE_BYTES;

    // head -c 로 상한 적용 후 base64
    let b64 = exec(&format!("head -c {cap} {quoted} | base64"))?;
    let cleaned: String = b64.split_whitespace().collect();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&cleaned)
        .map_err(|e| format!("base64: {e}"))?;

    let content = if kind == "text" || kind == "markdown" {
        String::from_utf8_lossy(&bytes).into_owned()
    } else {
        cleaned
    };

    Ok(FileContent {
        name,
        path: path.to_string(),
        kind: kind.to_string(),
        content,
        size,
        mime: mime.map(str::to_string),
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn directory_admission_accepts_non_git_folders_and_rejects_missing_or_file_paths() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(
            inspect_local_directory(root.path().to_string_lossy().into_owned()),
            Ok(root.path().canonicalize().unwrap().to_str().unwrap().to_owned())
        );
        let missing = root.path().join("missing");
        assert!(inspect_local_directory(missing.to_string_lossy().into_owned()).is_err());
        let file = root.path().join("file");
        std::fs::write(&file, b"owned fixture").unwrap();
        assert!(inspect_local_directory(file.to_string_lossy().into_owned())
            .unwrap_err()
            .contains("not a directory"));
        assert!(inspect_local_directory(".".into())
            .unwrap_err()
            .contains("absolute"));
    }

    #[cfg(unix)]
    #[test]
    fn directory_admission_resolves_a_non_git_folder_alias_without_git() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("workspace");
        let alias = root.path().join("alias");
        std::fs::create_dir(&target).unwrap();
        std::os::unix::fs::symlink(&target, &alias).unwrap();
        assert_eq!(
            inspect_local_directory(alias.to_str().unwrap().to_owned()).unwrap(),
            target.canonicalize().unwrap().to_str().unwrap(),
        );
        assert!(std::fs::symlink_metadata(alias).unwrap().file_type().is_symlink());
    }

    #[test]
    fn write_local_replaces_content_and_leaves_no_temp_file() {
        let dir = std::env::temp_dir().join(format!("agent-ide-files-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sample.txt");
        std::fs::write(&path, "before").unwrap();

        let n = write_local(path.to_str().unwrap(), "after\nlines").unwrap();
        assert_eq!(n, 11);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "after\nlines");

        // 임시 파일이 남지 않아야 한다 (파일 트리에 .tmp가 보이면 안 됨)
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains("agent-ide.tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp files left: {leftovers:?}");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_local_creates_new_file() {
        let dir = std::env::temp_dir().join(format!("agent-ide-new-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("fresh.md");

        write_local(path.to_str().unwrap(), "# hi").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "# hi");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_local_rejects_directory() {
        let dir = std::env::temp_dir();
        assert!(write_local(dir.to_str().unwrap(), "x").is_err());
    }

    #[test]
    fn classify_routes_playable_video_to_the_viewer() {
        assert_eq!(classify("clip.webm"), ("video", Some("video/webm")));
        assert_eq!(classify("Clip.MOV"), ("video", Some("video/quicktime")));
        // WebKit이 못 여는 컨테이너와 오디오는 binary로 남는다(외부 열기 안내).
        assert_eq!(classify("raw.mkv").0, "binary");
        assert_eq!(classify("voice.mp3").0, "binary");
    }

    #[test]
    fn quote_remote_keeps_tilde_outside_quotes() {
        // ~ 가 따옴표 안에 들어가면 셸이 홈으로 확장하지 못한다.
        assert_eq!(quote_remote("~/a b.md"), "~/'a b.md'");
        assert_eq!(quote_remote("/tmp/x.txt"), "'/tmp/x.txt'");
        assert_eq!(quote_remote("/tmp/it's.txt"), "'/tmp/it'\\''s.txt'");
    }

    #[test]
    fn write_remote_chunks_and_moves_atomically() {
        let sent: RefCell<Vec<String>> = RefCell::new(Vec::new());
        let content = "x".repeat(100_000); // base64로 ~133KB → 여러 청크
        let n = write_remote(
            |cmd| {
                sent.borrow_mut().push(cmd.to_string());
                Ok("ok\n".into())
            },
            "~/big.txt",
            &content,
        )
        .unwrap();

        assert_eq!(n, 100_000);
        let cmds = sent.borrow();
        // 첫 청크는 덮어쓰기(>), 나머지는 이어붙이기(>>)
        assert!(cmds[0].contains("printf '%s'") && cmds[0].contains("> ~/'big.txt.agent-ide.tmp'.b64"));
        assert!(cmds.len() > 3, "expected chunking, got {} commands", cmds.len());
        assert!(cmds[1].contains(">> ~/'big.txt.agent-ide.tmp'.b64"));
        // 마지막은 디코드 후 원본 자리로 mv
        let last = cmds.last().unwrap();
        assert!(last.contains("base64 -d") && last.contains("mv ") && last.contains("~/'big.txt'"));
    }

    #[test]
    fn rank_candidates_prefers_deeper_suffix_match() {
        let found = vec![
            "other/TerminalView.tsx".to_string(),
            "src/components/TerminalView.tsx".to_string(),
            "a/b/c/d/TerminalView.tsx".to_string(),
        ];
        // 찾던 경로가 src/components/... 였다면 구간이 더 많이 겹치는 쪽이 앞
        let ranked = rank_candidates("src/components/TerminalView.tsx", found, 10);
        assert_eq!(ranked[0], "src/components/TerminalView.tsx");
    }

    #[test]
    fn rank_candidates_prefers_shorter_path_on_tie() {
        // basename만 아는 경우(구간 일치 깊이가 모두 1) 얕은 경로가 앞
        let found = vec![
            "a/b/c/x.ts".to_string(),
            "x.ts".to_string(),
            "a/x.ts".to_string(),
        ];
        let ranked = rank_candidates("x.ts", found, 10);
        assert_eq!(ranked, vec!["x.ts", "a/x.ts", "a/b/c/x.ts"]);
    }

    #[test]
    fn find_local_candidates_locates_file_by_name_in_repo() {
        // 이 저장소 안에서 실행되므로 실제 파일로 확인한다.
        let root = std::env::current_dir().unwrap();
        // src-tauri 에서 돌 수도 있으니 상위로 한 번 올라가 본다
        let repo = if root.join("src/components/terminal/TerminalView.tsx").exists() {
            root
        } else {
            root.parent().unwrap().to_path_buf()
        };
        let missing = repo.join("TerminalView.tsx");
        let found = find_local_candidates(missing.to_str().unwrap(), 10);
        assert!(
            found.iter().any(|p| p.ends_with("src/components/terminal/TerminalView.tsx")),
            "expected to locate TerminalView.tsx, got {found:?}"
        );
    }

    #[test]
    fn find_local_candidates_returns_empty_for_unknown_name() {
        let root = std::env::current_dir().unwrap();
        let missing = root.join("definitely-not-a-real-file-9182.tsx");
        assert!(find_local_candidates(missing.to_str().unwrap(), 10).is_empty());
    }

    #[test]
    fn find_remote_candidates_parses_root_and_ranks() {
        let found = find_remote_candidates(
            |_| Ok("/srv/repo
src/components/TerminalView.tsx
vendor/TerminalView.tsx
".into()),
            "/srv/repo/TerminalView.tsx",
            10,
        );
        assert_eq!(
            found,
            vec![
                "/srv/repo/vendor/TerminalView.tsx",
                "/srv/repo/src/components/TerminalView.tsx",
            ]
        );
    }

    #[test]
    fn write_remote_reports_failure() {
        assert!(write_remote(|_| Ok("fail\n".into()), "/tmp/x.txt", "hi").is_err());
    }

    #[test]
    fn delete_remote_rejects_root_parent_and_ambiguous_paths_without_exec() {
        let calls = RefCell::new(0);
        assert!(delete_remote(
            |_: &str| {
                *calls.borrow_mut() += 1;
                Ok(REMOTE_DELETE_OK.into())
            },
            "/srv/repo",
            "/srv/repo",
            true,
        )
        .is_err());
        assert!(delete_remote(
            |_: &str| {
                *calls.borrow_mut() += 1;
                Ok(REMOTE_DELETE_OK.into())
            },
            "/srv/repo",
            "/srv/other/file",
            false,
        )
        .is_err());
        assert!(delete_remote(
            |_: &str| {
                *calls.borrow_mut() += 1;
                Ok(REMOTE_DELETE_OK.into())
            },
            "/srv/repo",
            "/srv/repo/../secret",
            false,
        )
        .is_err());
        assert!(delete_remote(
            |_: &str| {
                *calls.borrow_mut() += 1;
                Ok(REMOTE_DELETE_OK.into())
            },
            "/srv/repo",
            "relative.txt",
            false,
        )
        .is_err());
        assert_eq!(*calls.borrow(), 0);
    }

    #[test]
    fn delete_remote_checks_physical_parent_and_deletes_exact_file() {
        let sent = RefCell::new(String::new());
        delete_remote(
            |command| {
                *sent.borrow_mut() = command.to_string();
                Ok(format!("{REMOTE_DELETE_OK}\n"))
            },
            "~/repo",
            "~/repo/src/it's.txt",
            false,
        )
        .unwrap();

        let command = sent.borrow();
        assert!(command.contains("root_real=$(cd ~/'repo'"));
        assert!(command.contains("parent_real=$(cd ~/'repo/src'"));
        assert!(command.contains("candidate=\"$parent_real\"/'it'\\''s.txt'"));
        assert!(command.contains("rm -f -- \"$candidate\""));
        assert!(!command.contains("rm -rf -- \"$candidate\""));
    }

    #[test]
    fn delete_remote_uses_recursive_remove_only_for_a_checked_directory() {
        let sent = RefCell::new(String::new());
        delete_remote(
            |command| {
                *sent.borrow_mut() = command.to_string();
                Ok(format!("{REMOTE_DELETE_OK}\n"))
            },
            "/srv/repo",
            "/srv/repo/build",
            true,
        )
        .unwrap();
        let command = sent.borrow();
        assert!(command.contains("[ -L \"$candidate\" ]"));
        assert!(command.contains("rm -rf -- \"$candidate\""));
    }

    #[test]
    fn delete_remote_requires_the_exact_success_marker() {
        assert!(delete_remote(
            |_| Ok("__DURE_REMOTE_DELETE_OK_V1___spoof\n".into()),
            "/srv/repo",
            "/srv/repo/file.txt",
            false,
        )
        .is_err());
    }
}
