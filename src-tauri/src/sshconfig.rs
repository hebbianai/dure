//! `~/.ssh/config` 읽기 전용 스캔 — 원격 탐색기에 "설정 파일별 폴더"로 호스트를 띄운다.
//!
//! ssh(1) 의미론 중 이 화면에 필요한 부분만 구현한다:
//!   - Host 블록의 비-와일드카드 별칭만 연결 가능한 항목으로 본다
//!   - Include 를 따라가되 결과는 파일별로 분리해 출처(폴더)를 유지한다
//!   - 와일드카드 블록(`Host *`)은 기본값으로만 쓰고 목록에는 넣지 않는다
//!
//! Match 블록은 조건을 평가하지 않고 통째로 건너뛴다. 조건을 무시하면 실제로는
//! 적용되지 않는 설정으로 호스트를 만들어버리기 때문이다.
//!
//! 기본값 적용은 "호스트 블록이 이기고, 와일드카드 블록이 폴백"이다. 실제 ssh는
//! 파일 순서상 먼저 나온 값이 이기므로 `Host *`를 맨 위에 둔 설정과는 차이가 날 수
//! 있으나, 관례대로 맨 아래(혹은 맨 위에서 공통 User만) 두는 설정과는 일치한다.

mod inspection;

use inspection::{collect, AliasInspection};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// Include 폭주 방지 — 사용자 설정에서 현실적으로 넘지 않는 선.
const MAX_FILES: usize = 64;
const MAX_DEPTH: usize = 8;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigHost {
    /// `Host` 별칭 — 사이드바에 뜨는 이름이자 `ssh <alias>`의 인자.
    pub alias: String,
    /// `HostName`(없으면 별칭) — 실제 접속 대상.
    pub host_name: String,
    pub user: Option<String>,
    pub port: Option<u16>,
    /// `IdentityFile` — `~`, `%d` 전개 완료된 절대경로.
    pub identity_file: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigFile {
    pub path: String,
    /// 홈 아래면 `~/.ssh/config` 형태 — 폴더 라벨로 그대로 쓴다.
    pub display_path: String,
    pub hosts: Vec<SshConfigHost>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigScan {
    /// 호스트가 하나도 없는 파일은 폴더가 비어 보이므로 제외한다.
    pub files: Vec<SshConfigFile>,
    /// `User`가 없는 호스트에 쓸 로컬 사용자명.
    pub default_user: String,
    pub alias_inspection: AliasInspection,
}

#[tauri::command]
pub fn ssh_config_hosts() -> Result<SshConfigScan, String> {
    let home = dirs::home_dir().ok_or_else(|| "Could not find the home directory".to_string())?;
    #[cfg(unix)]
    let system = Some(PathBuf::from("/etc/ssh/ssh_config"));
    #[cfg(windows)]
    let system = std::env::var_os("PROGRAMDATA")
        .map(|root| PathBuf::from(root).join("ssh").join("ssh_config"));
    Ok(scan(
        &home.join(".ssh").join("config"),
        &home,
        local_user(),
        system.as_deref(),
    ))
}

fn local_user() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_default()
}

fn scan(root: &Path, home: &Path, default_user: String, system: Option<&Path>) -> SshConfigScan {
    let mut seen = HashSet::new();
    let mut collected = Vec::new();
    let user_complete = collect(root, home, &home.join(".ssh"), 0, &mut seen, &mut collected);
    let user_file_count = collected.len();
    let system_complete = system.is_some_and(|path| {
        collect(
            path,
            home,
            path.parent().unwrap_or(Path::new("/")),
            0,
            &mut seen,
            &mut collected,
        )
    });
    let alias_inspection = inspection::inspect(&collected, user_complete && system_complete);
    // System files contribute alias evidence, without changing sidebar contents.
    let user_files = &collected[..user_file_count];
    let defaults = wildcard_defaults(user_files, home);
    let files = user_files
        .iter()
        .filter_map(|(path, text)| {
            let hosts = hosts_in(text, home, &defaults);
            if hosts.is_empty() {
                return None;
            }
            Some(SshConfigFile {
                path: path.to_string_lossy().into_owned(),
                display_path: display_path(path, home),
                hosts,
            })
        })
        .collect();

    SshConfigScan {
        files,
        default_user,
        alias_inspection,
    }
}

/// 와일드카드 블록(`Host *`)에서 공통 기본값을 모은다 — 먼저 나온 값이 이긴다.
fn wildcard_defaults(files: &[(PathBuf, String)], home: &Path) -> HashMap<String, String> {
    let mut defaults: HashMap<String, String> = HashMap::new();
    for (_, text) in files {
        for block in blocks(text) {
            if !block.patterns.iter().any(|p| is_wildcard(p)) {
                continue;
            }
            for key in ["user", "port", "identityfile"] {
                if let Some(value) = block.options.get(key) {
                    defaults
                        .entry(key.to_string())
                        .or_insert_with(|| normalize(key, value, home, ""));
                }
            }
        }
    }
    defaults
}

fn hosts_in(text: &str, home: &Path, defaults: &HashMap<String, String>) -> Vec<SshConfigHost> {
    let mut hosts: Vec<SshConfigHost> = Vec::new();
    let mut claimed: HashSet<String> = HashSet::new();

    for block in blocks(text) {
        for pattern in &block.patterns {
            // 와일드카드는 기본값 전용, `!`는 제외 패턴 — 둘 다 연결 대상이 아니다.
            if is_wildcard(pattern) || pattern.starts_with('!') {
                continue;
            }
            // 같은 파일에서 같은 별칭이 반복되면 ssh와 같이 먼저 나온 블록이 이긴다.
            if !claimed.insert(pattern.to_ascii_lowercase()) {
                continue;
            }
            let option = |key: &str| -> Option<String> {
                block
                    .options
                    .get(key)
                    .map(|value| normalize(key, value, home, pattern))
                    .or_else(|| defaults.get(key).cloned())
            };
            hosts.push(SshConfigHost {
                alias: pattern.clone(),
                host_name: option("hostname").unwrap_or_else(|| pattern.clone()),
                user: option("user"),
                port: option("port").and_then(|p| p.parse::<u16>().ok()),
                identity_file: option("identityfile"),
            });
        }
    }
    hosts
}

struct Block {
    patterns: Vec<String>,
    /// 블록 안에서도 먼저 나온 값이 이긴다(ssh 동작).
    options: HashMap<String, String>,
}

fn blocks(text: &str) -> Vec<Block> {
    let mut blocks: Vec<Block> = Vec::new();
    // Match 블록 안에서는 조건을 모르므로 옵션을 수집하지 않는다.
    let mut skipping = false;

    for line in text.lines() {
        let Some((keyword, rest)) = split_keyword(line) else {
            continue;
        };
        match keyword.as_str() {
            "host" => {
                skipping = false;
                blocks.push(Block {
                    patterns: split_args(&rest),
                    options: HashMap::new(),
                });
            }
            "match" => skipping = true,
            _ => {
                if skipping {
                    continue;
                }
                if let Some(block) = blocks.last_mut() {
                    block.options.entry(keyword).or_insert_with(|| rest.clone());
                }
            }
        }
    }
    blocks
}

/// ssh(1)은 `keyword arg`와 `keyword=arg`를 모두 받고, 주석은 줄 전체(`#`)만이다.
fn split_keyword(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }
    let boundary = trimmed.find(|c: char| c.is_whitespace() || c == '=');
    let (keyword, rest) = match boundary {
        Some(index) => (
            &trimmed[..index],
            trimmed[index..].trim_matches(|c: char| c.is_whitespace() || c == '='),
        ),
        None => (trimmed, ""),
    };
    if keyword.is_empty() {
        return None;
    }
    Some((keyword.to_ascii_lowercase(), rest.to_string()))
}

/// 공백 구분 + 큰따옴표 묶음(`IdentityFile "~/.ssh/my key"`).
fn split_args(rest: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for ch in rest.chars() {
        match ch {
            '"' => quoted = !quoted,
            c if c.is_whitespace() && !quoted => {
                if !current.is_empty() {
                    args.push(std::mem::take(&mut current));
                }
            }
            c => current.push(c),
        }
    }
    if !current.is_empty() {
        args.push(current);
    }
    args
}

fn is_wildcard(pattern: &str) -> bool {
    pattern.contains('*') || pattern.contains('?')
}

/// 값 하나를 화면/접속에 바로 쓸 수 있는 형태로 — 따옴표 제거, 경로/토큰 전개.
fn normalize(key: &str, value: &str, home: &Path, alias: &str) -> String {
    let raw = split_args(value).into_iter().next().unwrap_or_default();
    match key {
        "identityfile" => expand_path(&raw, home).to_string_lossy().into_owned(),
        "hostname" => raw.replace("%h", alias),
        _ => raw,
    }
}

/// `~`, `~/`, `%d`(홈)를 전개하고 상대경로는 그대로 둔다.
fn expand_path(raw: &str, home: &Path) -> PathBuf {
    let replaced = raw.replace("%d", &home.to_string_lossy());
    if replaced == "~" {
        return home.to_path_buf();
    }
    if let Some(rest) = replaced.strip_prefix("~/") {
        return home.join(rest);
    }
    PathBuf::from(replaced)
}

/// `*`, `?`만 지원하는 최소 글롭 — Include 파일명 매칭 전용.
fn glob_match(pattern: &str, text: &str) -> bool {
    let pattern: Vec<char> = pattern.chars().collect();
    let text: Vec<char> = text.chars().collect();
    let (mut p, mut t) = (0usize, 0usize);
    // `*`를 만난 위치를 기억했다가 실패하면 한 글자 더 먹이고 재시도한다.
    let (mut star, mut resume) = (None, 0usize);

    while t < text.len() {
        if p < pattern.len() && (pattern[p] == '?' || pattern[p] == text[t]) {
            p += 1;
            t += 1;
        } else if p < pattern.len() && pattern[p] == '*' {
            star = Some(p);
            resume = t;
            p += 1;
        } else if let Some(index) = star {
            p = index + 1;
            resume += 1;
            t = resume;
        } else {
            return false;
        }
    }
    pattern[p..].iter().all(|c| *c == '*')
}

fn display_path(path: &Path, home: &Path) -> String {
    match path.strip_prefix(home) {
        Ok(rest) => format!("~/{}", rest.to_string_lossy().replace('\\', "/")),
        Err(_) => path.to_string_lossy().into_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_aliases_participate_in_inspection_without_adding_sidebar_hosts() {
        let home = tempfile::tempdir().unwrap();
        let user = write(&home.path().join(".ssh"), "config", "Host user.example\n");
        let system = write(home.path(), "system_config", "Host system.example\n");
        let result = scan(&user, home.path(), "local".into(), Some(&system));
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].hosts[0].alias, "user.example");
        assert_eq!(
            result.alias_inspection,
            AliasInspection::Complete {
                aliases: vec!["system.example".into(), "user.example".into()],
            }
        );
        assert_eq!(
            scan(&user, home.path(), "local".into(), None).alias_inspection,
            AliasInspection::Partial
        );
    }

    fn write(dir: &Path, name: &str, text: &str) -> PathBuf {
        let path = dir.join(name);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&path, text).unwrap();
        path
    }

    /// 테스트용 홈 — 같은 프로세스의 다른 테스트와 섞이지 않게 이름을 분리한다.
    fn temp_home(tag: &str) -> PathBuf {
        let home = std::env::temp_dir().join(format!("agent-ide-sshconfig-{tag}"));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(home.join(".ssh")).unwrap();
        home
    }

    #[test]
    fn reads_hosts_with_defaults_and_skips_wildcards() {
        let home = temp_home("basic");
        let root = write(
            &home.join(".ssh"),
            "config",
            "Host *\n  User fallback\n  IdentityFile ~/.ssh/id_ed25519\n\
             \nHost gate\n  HostName 10.0.0.1\n  Port 2222\n  User ops\n\
             \nHost box\n  HostName 10.0.0.2\n",
        );

        let scan = scan(&root, &home, "local".into(), None);
        let hosts = &scan.files[0].hosts;

        assert_eq!(hosts.len(), 2, "와일드카드 블록은 목록에 없어야 한다");
        assert_eq!(hosts[0].alias, "gate");
        assert_eq!(hosts[0].host_name, "10.0.0.1");
        assert_eq!(hosts[0].port, Some(2222));
        assert_eq!(hosts[0].user.as_deref(), Some("ops"));
        // Host 블록이 없는 값만 와일드카드 기본값을 물려받는다.
        assert_eq!(hosts[1].user.as_deref(), Some("fallback"));
        assert_eq!(hosts[1].port, None);
        assert_eq!(
            hosts[1].identity_file,
            Some(home.join(".ssh/id_ed25519").to_string_lossy().into_owned())
        );
        assert_eq!(scan.files[0].display_path, "~/.ssh/config");
    }

    #[test]
    fn follows_includes_as_separate_files() {
        let home = temp_home("include");
        write(
            &home.join(".ssh"),
            "extra_config",
            "Host from-include\n  HostName 10.0.0.9\n",
        );
        let root = write(
            &home.join(".ssh"),
            "config",
            "Include extra_config\n\nHost main\n  HostName 10.0.0.1\n",
        );

        let scan = scan(&root, &home, "local".into(), None);

        assert_eq!(scan.files.len(), 2);
        assert_eq!(scan.files[0].display_path, "~/.ssh/config");
        assert_eq!(scan.files[0].hosts[0].alias, "main");
        assert_eq!(scan.files[1].display_path, "~/.ssh/extra_config");
        assert_eq!(scan.files[1].hosts[0].alias, "from-include");
    }

    #[test]
    fn expands_include_globs_and_stops_cycles() {
        let home = temp_home("glob");
        write(
            &home.join(".ssh/conf.d"),
            "b.conf",
            "Host beta\n  HostName 10.0.0.3\n",
        );
        write(
            &home.join(".ssh/conf.d"),
            "a.conf",
            "Host alpha\n  HostName 10.0.0.2\n",
        );
        // 자기 자신을 다시 include 해도 무한 재귀에 빠지지 않아야 한다.
        let root = write(
            &home.join(".ssh"),
            "config",
            "Include conf.d/*.conf\nInclude config\n\nHost root\n  HostName 10.0.0.1\n",
        );

        let scan = scan(&root, &home, "local".into(), None);

        let aliases: Vec<&str> = scan
            .files
            .iter()
            .flat_map(|f| f.hosts.iter().map(|h| h.alias.as_str()))
            .collect();
        assert_eq!(aliases, vec!["root", "alpha", "beta"]);
    }

    #[test]
    fn ignores_match_blocks_and_duplicate_aliases() {
        let home = temp_home("match");
        let root = write(
            &home.join(".ssh"),
            "config",
            "Host dup\n  HostName first\n\nHost dup\n  HostName second\n\
             \nMatch host anything\n  User matched\n\nHost after-match\n  HostName 10.0.0.4\n",
        );

        let scan = scan(&root, &home, "local".into(), None);
        let hosts = &scan.files[0].hosts;

        assert_eq!(hosts.len(), 2);
        assert_eq!(
            hosts[0].host_name, "first",
            "같은 별칭은 먼저 나온 블록이 이긴다"
        );
        // Match 블록의 User는 어떤 호스트에도 새지 않아야 한다.
        assert!(hosts.iter().all(|h| h.user.is_none()));
        assert_eq!(hosts[1].alias, "after-match");
    }

    #[test]
    fn accepts_equals_and_quoted_values() {
        let home = temp_home("syntax");
        let root = write(
            &home.join(".ssh"),
            "config",
            "# 주석\nHost quoted\nHostName=10.0.0.5\n  IdentityFile \"~/.ssh/my key\"\n  Port = 2200\n",
        );

        let scan = scan(&root, &home, "local".into(), None);
        let host = &scan.files[0].hosts[0];

        assert_eq!(host.host_name, "10.0.0.5");
        assert_eq!(host.port, Some(2200));
        assert_eq!(
            host.identity_file,
            Some(home.join(".ssh/my key").to_string_lossy().into_owned())
        );
    }

    #[test]
    fn glob_matches_only_intended_names() {
        assert!(glob_match("*.conf", "a.conf"));
        assert!(glob_match("conf?.d", "conf1.d"));
        assert!(!glob_match("*.conf", "a.conf.bak"));
        assert!(!glob_match("conf?.d", "conf.d"));
    }
}
