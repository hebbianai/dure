//! Bounded read coverage for the host-list scanner. No Match commands execute.

use super::{
    expand_path, glob_match, is_wildcard, split_args, split_keyword, MAX_DEPTH, MAX_FILES,
};
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AliasInspection {
    Complete { aliases: Vec<String> },
    Partial,
}

/// The listing is intentionally partial; only complete read and syntax coverage
/// can establish that a network-looking token is not an SSH configuration alias.
pub(super) fn inspect(files: &[(PathBuf, String)], complete: bool) -> AliasInspection {
    if !complete {
        return AliasInspection::Partial;
    }
    let mut aliases = Vec::new();
    for (_, text) in files {
        let mut concrete_scope = false;
        let mut saw_host = false;
        for line in text.lines() {
            let Some((keyword, rest)) = split_keyword(line) else {
                continue;
            };
            // The existing tokenizer does not implement single quotes, escaping or continuations.
            if rest.contains(['\\', '\'']) || rest.matches('"').count() % 2 != 0 {
                return AliasInspection::Partial;
            }
            match keyword.as_str() {
                "host" => {
                    saw_host = true;
                    let patterns = split_args(&rest);
                    if patterns.is_empty()
                        || patterns
                            .iter()
                            .any(|p| p.starts_with('!') || (p != "*" && is_wildcard(p)))
                    {
                        return AliasInspection::Partial;
                    }
                    concrete_scope = !patterns.iter().any(|p| p == "*");
                    aliases.extend(
                        patterns
                            .into_iter()
                            .filter(|p| p != "*")
                            .map(|p| p.to_ascii_lowercase()),
                    );
                }
                "match" => return AliasInspection::Partial,
                "include" if saw_host => return AliasInspection::Partial,
                "include" => {}
                // Explicit argv user/port override these defaults. The other
                // options below cannot redirect the endpoint or select credentials.
                "user"
                | "port"
                | "sendenv"
                | "xauthlocation"
                | "loglevel"
                | "serveraliveinterval"
                | "serveralivecountmax"
                | "tcpkeepalive"
                | "hashknownhosts" => {}
                "canonicalizehostname" if rest.eq_ignore_ascii_case("no") => {}
                _ if concrete_scope => {}
                _ => return AliasInspection::Partial,
            }
        }
    }
    aliases.sort();
    aliases.dedup();
    AliasInspection::Complete { aliases }
}

pub(super) fn collect(
    path: &Path,
    home: &Path,
    include_base: &Path,
    depth: usize,
    seen: &mut HashSet<PathBuf>,
    out: &mut Vec<(PathBuf, String)>,
) -> bool {
    if depth > MAX_DEPTH || out.len() >= MAX_FILES {
        return false;
    }
    let identity = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    if !seen.insert(identity) {
        return false;
    }
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) => return error.kind() == std::io::ErrorKind::NotFound,
    };
    let mut includes = Vec::new();
    let mut complete = true;
    for line in text.lines() {
        let Some((keyword, rest)) = split_keyword(line) else {
            continue;
        };
        if keyword == "include" {
            let tokens = split_args(&rest);
            complete &= !tokens.is_empty();
            for token in tokens {
                match expand_include(&token, home, include_base) {
                    Ok(paths) => includes.extend(paths),
                    Err(()) => complete = false,
                }
            }
        }
    }
    out.push((path.to_path_buf(), text));
    for target in includes {
        complete &= collect(&target, home, include_base, depth + 1, seen, out);
    }
    complete
}

/// A deliberately limited glob subset. Unsupported paths are incomplete, not empty.
fn expand_include(token: &str, home: &Path, include_base: &Path) -> Result<Vec<PathBuf>, ()> {
    let expanded = expand_path(token, home);
    let raw = expanded.to_str().ok_or(())?;
    if raw.contains(['%', '$', '[', ']', '~', '\\']) {
        return Err(());
    }
    let path = if expanded.is_absolute() {
        expanded
    } else {
        include_base.join(expanded)
    };
    let name = path.file_name().and_then(|n| n.to_str()).ok_or(())?;
    let parent = path.parent().ok_or(())?;
    if is_wildcard(&parent.to_string_lossy()) {
        return Err(());
    }
    if !is_wildcard(name) {
        return Ok(vec![path]);
    }
    let entries = match std::fs::read_dir(parent) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err(()),
    };
    let mut matched = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|_| ())?;
        let name_on_disk = entry.file_name();
        let name_on_disk = name_on_disk.to_str().ok_or(())?;
        if glob_match(name, name_on_disk) {
            if matched.len() >= MAX_FILES {
                return Err(());
            }
            matched.push(entry.path());
        }
    }
    matched.sort();
    Ok(matched)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inspected(text: &str) -> AliasInspection {
        inspect(&[(PathBuf::from("fixture"), text.into())], true)
    }

    #[test]
    fn aliases_are_preserved_but_conditional_or_unknown_global_rules_are_partial() {
        assert_eq!(inspected("Host ALIAS.example\n HostName actual.example\nHost *\n User default\n SendEnv LANG\n"), AliasInspection::Complete { aliases: vec!["alias.example".into()] });
        for text in [
            "Match exec false\n HostName actual.example",
            "Host *.example\n HostName actual.example",
            "Host *\n HostName actual.example",
            "CanonicalizeHostname yes",
            "ProxyJump jump",
            "IdentityFile ~/.ssh/custom",
            "Host specific\n Include conditional",
            "Host !excluded *",
            "Host \"unterminated",
            "Host test\\ alias",
            "Host 'example.com'\n HostName redirected.example",
            "UnknownSetting value",
        ] {
            assert_eq!(inspected(text), AliasInspection::Partial, "{text}");
        }
    }

    #[test]
    fn missing_files_are_absent_but_read_failures_limits_and_unsupported_globs_are_partial() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join("config");
        let gather = || {
            let mut files = Vec::new();
            let complete = collect(
                &root,
                home.path(),
                home.path(),
                0,
                &mut HashSet::new(),
                &mut files,
            );
            inspect(&files, complete)
        };
        assert_eq!(gather(), AliasInspection::Complete { aliases: vec![] });
        for text in [
            "Include [ab].conf",
            "Include */config",
            "Include ${UNRESOLVED}/config",
            "Include config",
        ] {
            std::fs::write(&root, text).unwrap();
            assert_eq!(gather(), AliasInspection::Partial, "{text}");
        }
        std::fs::write(&root, "Include unreadable").unwrap();
        std::fs::create_dir(home.path().join("unreadable")).unwrap();
        assert_eq!(gather(), AliasInspection::Partial);
        assert!(!collect(
            &root,
            home.path(),
            home.path(),
            MAX_DEPTH + 1,
            &mut HashSet::new(),
            &mut Vec::new()
        ));
    }

    #[test]
    fn include_base_and_lexical_order_are_explicit_and_no_match_command_runs() {
        let home = tempfile::tempdir().unwrap();
        let system = tempfile::tempdir().unwrap();
        std::fs::create_dir(system.path().join("conf.d")).unwrap();
        std::fs::write(
            system.path().join("config"),
            "Include conf.d/*.conf\nHost *\n XAuthLocation /fixture/xauth",
        )
        .unwrap();
        std::fs::write(system.path().join("conf.d/b.conf"), "Host beta.example").unwrap();
        std::fs::write(system.path().join("conf.d/a.conf"), "Host alpha.example").unwrap();
        let mut files = Vec::new();
        let complete = collect(
            &system.path().join("config"),
            home.path(),
            system.path(),
            0,
            &mut HashSet::new(),
            &mut files,
        );
        assert_eq!(
            inspect(&files, complete),
            AliasInspection::Complete {
                aliases: vec!["alpha.example".into(), "beta.example".into()]
            }
        );
        assert!(files[1].0.ends_with("a.conf"));
        let marker = home.path().join("never-created");
        assert_eq!(
            inspected(&format!("Match exec \"touch {}\"", marker.display())),
            AliasInspection::Partial
        );
        assert!(!marker.exists());
    }
}
