//! Where one exact conversation's transcript is, across the provider's
//! default state root and Dure's account profiles.
//!
//! A managed agent launched under a Dure account profile has that profile as
//! its provider state root (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`), and the
//! process asking — the desktop, or `hmux mobile-gateway` on a server — is
//! not told which one. The conversation id is the provider's own, so the
//! exact conversation is looked for in the default root and in each of the
//! provider's profiles under `<home>/.dure/accounts`, and the most recently
//! written copy is read.

use crate::{
    ConversationTurnRole, ProviderConversationTranscript, claude_turn, codex_turn,
    find_claude_conversation, find_codex_conversation, mtime, safe_id, transcript_from_file,
};
use serde_json::Value;
use std::collections::HashSet;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

/// The most entries of the account root one lookup looks through, and the
/// most profiles of one provider it searches.
const MAX_ACCOUNT_ROOT_ENTRIES: usize = 256;
const MAX_ACCOUNT_PROFILES: usize = 32;

/// The provider's own default conversation roots for one user.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderStateRoots {
    pub claude_projects: PathBuf,
    pub codex_sessions: PathBuf,
}

impl ProviderStateRoots {
    /// The roots the providers themselves would use: `CLAUDE_CONFIG_DIR` or
    /// `~/.claude`, and `CODEX_HOME` or `~/.codex`. An empty override is no
    /// override, as for the providers.
    #[must_use]
    pub fn resolve(
        home: &Path,
        claude_config_dir: Option<OsString>,
        codex_home: Option<OsString>,
    ) -> Self {
        let root = |value: Option<OsString>, default: &str| {
            value
                .filter(|value| !value.is_empty())
                .map_or_else(|| home.join(default), PathBuf::from)
        };
        Self {
            claude_projects: root(claude_config_dir, ".claude").join("projects"),
            codex_sessions: root(codex_home, ".codex").join("sessions"),
        }
    }
}

/// The provider's account profile directories a managed launch would accept:
/// `<home>/.dure/accounts/<provider>-*`, each a real directory, as are the
/// account root and the Dure root above it. `owned` says whether a directory
/// belongs to the user asking; the caller supplies it because the effective
/// user id is not something std reports.
pub fn account_profile_directories(
    home: &Path,
    provider: &str,
    owned: impl Fn(&fs::Metadata) -> bool,
) -> Vec<PathBuf> {
    let real_owned_directory = |path: &Path| {
        fs::symlink_metadata(path)
            .is_ok_and(|metadata| metadata.is_dir() && owned(&metadata))
            .then(|| fs::canonicalize(path).ok())
            .flatten()
    };
    let dure_root = home.join(".dure");
    let account_root = dure_root.join("accounts");
    if real_owned_directory(&dure_root).is_none() {
        return Vec::new();
    }
    let Some(account_root) = real_owned_directory(&account_root) else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(&account_root) else {
        return Vec::new();
    };
    let prefix = format!("{provider}-");
    entries
        .flatten()
        .take(MAX_ACCOUNT_ROOT_ENTRIES)
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with(&prefix))
        })
        .filter_map(|entry| real_owned_directory(&entry.path()))
        .filter(|profile| profile.parent() == Some(account_root.as_path()))
        .take(MAX_ACCOUNT_PROFILES)
        .collect()
}

/// Read one exact conversation from the most recently written copy across the
/// default roots and `profiles`.
pub fn read_newest(
    roots: &ProviderStateRoots,
    profiles: &[PathBuf],
    provider: &str,
    conversation_id: &str,
) -> Result<ProviderConversationTranscript, String> {
    let parse: fn(&Value) -> Option<(ConversationTurnRole, String)> = match provider {
        "claude" => claude_turn,
        "codex" => codex_turn,
        _ => return Err("provider transcript export is unsupported".to_string()),
    };
    let path = newest_conversation_file(roots, profiles, provider, conversation_id)?;
    transcript_from_file(&path, provider, conversation_id, parse)
}

/// The most recently written file of an exact conversation. A directory a
/// profile link resolves to that was already searched is not searched again.
pub fn newest_conversation_file(
    roots: &ProviderStateRoots,
    profiles: &[PathBuf],
    provider: &str,
    conversation_id: &str,
) -> Result<PathBuf, String> {
    if !matches!(provider, "claude" | "codex") {
        return Err("provider transcript export is unsupported".to_string());
    }
    if !safe_id(conversation_id) {
        return Err("provider conversation id is invalid".to_string());
    }
    let directories: Vec<PathBuf> =
        if provider == "claude" {
            std::iter::once(roots.claude_projects.clone())
                .chain(profiles.iter().map(|profile| profile.join("projects")))
                .collect()
        } else {
            let default_archive = roots
                .codex_sessions
                .parent()
                .map(|root| root.join("archived_sessions"));
            std::iter::once(roots.codex_sessions.clone())
                .chain(default_archive)
                .chain(profiles.iter().flat_map(|profile| {
                    [profile.join("sessions"), profile.join("archived_sessions")]
                }))
                .collect()
        };
    let mut searched = HashSet::new();
    let mut newest: Option<(u64, PathBuf)> = None;
    for directory in directories {
        let Ok(canonical) = fs::canonicalize(&directory) else {
            continue;
        };
        if !searched.insert(canonical.clone()) {
            continue;
        }
        let found = if provider == "claude" {
            find_claude_conversation(&canonical, conversation_id)
                .map(|(_, path)| (mtime(&path), path))
        } else {
            find_codex_conversation(&canonical, conversation_id, 0, &mut 0)
        };
        if found.as_ref().is_some_and(|(modified, _)| {
            newest
                .as_ref()
                .is_none_or(|(current, _)| modified > current)
        }) {
            newest = found;
        }
    }
    newest
        .map(|(_, path)| path)
        .ok_or_else(|| "provider conversation was not found".to_string())
}

#[cfg(test)]
#[path = "accounts_tests.rs"]
mod tests;
