//! Reviewed field projection for Claude's mixed identity/state document.
//!
//! `.claude.json` is replace-written and contains both OAuth identity and
//! shareable MCP/trust state. This module flattens only reviewed fields into
//! one key/value authority; every unreviewed field stays in its source file.

use super::{
    FaultInjection, FileGeneration, OverlayTransaction, atomic_replace_regular_file, lock_profile,
    require_owned_real_directory, typed_error,
};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

const SCHEMA_VERSION: u64 = 1;
const STATE_FILE: &str = ".claude.json";
const MANIFEST_FILE: &str = ".claude-shared-state-v1.json";
const MAX_BYTES: u64 = 16 * 1024 * 1024;
const MAX_ATTEMPTS: usize = 3;
const PROJECT_FIELDS: &[&str] = &[
    "disabledMcpjsonServers",
    "enabledMcpjsonServers",
    "hasClaudeMdExternalIncludesApproved",
    "hasClaudeMdExternalIncludesWarningShown",
    "hasTrustDialogAccepted",
];

#[derive(Clone, Eq, Ord, PartialEq, PartialOrd)]
enum SharedKey {
    UserMcp(String),
    ProjectMcp(String, String),
    ProjectField(String, String),
}

type SharedState = BTreeMap<SharedKey, Value>;

#[derive(Default)]
struct Manifest {
    authority: SharedState,
    sources: BTreeSet<String>,
}

struct Source {
    id: String,
    path: PathBuf,
    document: Map<String, Value>,
    state: SharedState,
    version: Option<FileGeneration>,
}

struct WritePlan {
    path: PathBuf,
    bytes: Vec<u8>,
    expected: Option<FileGeneration>,
}

fn error(code: &str, detail: &str) -> String {
    typed_error(code, format!("Claude shared state {detail}"))
}

fn mcp_entries(value: &Value, field: &str) -> Result<BTreeMap<String, Value>, String> {
    let object = value.as_object().ok_or_else(|| {
        error(
            "credential_shared_state_source_invalid",
            &format!("has invalid {field}"),
        )
    })?;
    if object.values().any(|definition| !definition.is_object()) {
        return Err(error(
            "credential_shared_state_source_invalid",
            &format!("has invalid {field}"),
        ));
    }
    Ok(object
        .iter()
        .map(|(name, definition)| (name.clone(), definition.clone()))
        .collect())
}

fn project_field(value: &Value, field: &str) -> Result<Value, String> {
    let valid = match field {
        "disabledMcpjsonServers" | "enabledMcpjsonServers" => value
            .as_array()
            .is_some_and(|values| values.iter().all(Value::is_string)),
        _ => value.is_boolean(),
    };
    if !valid {
        return Err(error(
            "credential_shared_state_source_invalid",
            &format!("has invalid projects.*.{field}"),
        ));
    }
    if let Some(values) = value.as_array() {
        let sorted: BTreeSet<&str> = values.iter().filter_map(Value::as_str).collect();
        return Ok(Value::Array(
            sorted.into_iter().map(|value| json!(value)).collect(),
        ));
    }
    Ok(value.clone())
}

fn extract(document: &Map<String, Value>) -> Result<SharedState, String> {
    let mut state = SharedState::new();
    if let Some(value) = document.get("mcpServers") {
        for (name, definition) in mcp_entries(value, "mcpServers")? {
            state.insert(SharedKey::UserMcp(name), definition);
        }
    }
    let Some(projects) = document.get("projects") else {
        return Ok(state);
    };
    let projects = projects.as_object().ok_or_else(|| {
        error(
            "credential_shared_state_source_invalid",
            "has invalid projects",
        )
    })?;
    for (project, value) in projects {
        let project_document = value.as_object().ok_or_else(|| {
            error(
                "credential_shared_state_source_invalid",
                "has invalid projects.*",
            )
        })?;
        if let Some(value) = project_document.get("mcpServers") {
            for (name, definition) in mcp_entries(value, "projects.*.mcpServers")? {
                state.insert(SharedKey::ProjectMcp(project.clone(), name), definition);
            }
        }
        for field in PROJECT_FIELDS {
            if let Some(value) = project_document.get(*field) {
                state.insert(
                    SharedKey::ProjectField(project.clone(), (*field).into()),
                    project_field(value, field)?,
                );
            }
        }
    }
    Ok(state)
}

fn object_at<'a>(object: &'a mut Map<String, Value>, key: &str) -> &'a mut Map<String, Value> {
    if !object.get(key).is_some_and(Value::is_object) {
        object.insert(key.into(), Value::Object(Map::new()));
    }
    object.get_mut(key).and_then(Value::as_object_mut).unwrap()
}

fn apply(document: &mut Map<String, Value>, state: &SharedState) {
    document.remove("mcpServers");
    if let Some(projects) = document.get_mut("projects").and_then(Value::as_object_mut) {
        for value in projects.values_mut() {
            let Some(project_document) = value.as_object_mut() else {
                continue;
            };
            project_document.remove("mcpServers");
            for field in PROJECT_FIELDS {
                project_document.remove(*field);
            }
        }
    }

    for (key, value) in state {
        match key {
            SharedKey::UserMcp(name) => {
                object_at(document, "mcpServers").insert(name.clone(), value.clone());
            }
            SharedKey::ProjectMcp(project, name) => {
                let project_document = object_at(object_at(document, "projects"), project.as_str());
                object_at(project_document, "mcpServers").insert(name.clone(), value.clone());
            }
            SharedKey::ProjectField(project, field) => {
                object_at(object_at(document, "projects"), project.as_str())
                    .insert(field.clone(), value.clone());
            }
        }
    }
}

fn state_value(state: &SharedState) -> Value {
    let mut document = Map::new();
    apply(&mut document, state);
    Value::Object(document)
}

fn apply_delta(
    authority: &mut SharedState,
    baseline: &SharedState,
    candidate: &SharedState,
    known_source: bool,
) {
    let keys: BTreeSet<&SharedKey> = if known_source {
        baseline.keys().chain(candidate.keys()).collect()
    } else {
        candidate.keys().collect()
    };
    for key in keys {
        let before = baseline.get(key);
        let after = candidate.get(key);
        if before == after {
            continue;
        }
        match after {
            Some(value) => {
                authority.insert(key.clone(), value.clone());
            }
            None => {
                authority.remove(key);
            }
        }
    }
}

fn trusted_version(metadata: &std::fs::Metadata, code: &str) -> Result<FileGeneration, String> {
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.nlink() != 1
    {
        return Err(error(code, "storage is not a single-link owned file"));
    }
    if metadata.len() > MAX_BYTES {
        return Err(error(code, "storage exceeds the reviewed size limit"));
    }
    Ok(FileGeneration::from(metadata))
}

fn read_file(path: &Path, code: &str) -> Result<Option<(Vec<u8>, FileGeneration)>, String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            trusted_version(&metadata, code)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => {
            return Err(error(
                "credential_shared_state_io",
                &format!("inspection failed: {source}"),
            ));
        }
    }
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|source| {
            error(
                "credential_shared_state_io",
                &format!("open failed: {source}"),
            )
        })?;
    let version = trusted_version(
        &file.metadata().map_err(|source| {
            error(
                "credential_shared_state_io",
                &format!("opened-file inspection failed: {source}"),
            )
        })?,
        code,
    )?;
    let mut bytes = Vec::with_capacity(version.length as usize);
    (&file)
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|source| {
            error(
                "credential_shared_state_io",
                &format!("read failed: {source}"),
            )
        })?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(error(code, "storage exceeds the reviewed size limit"));
    }
    Ok(Some((bytes, version)))
}

fn read_source(id: String, path: PathBuf) -> Result<Source, String> {
    let read = read_file(&path, "credential_shared_state_source_untrusted")?;
    let (document, version) = match read {
        Some((bytes, version)) => {
            let value: Value = serde_json::from_slice(&bytes).map_err(|_| {
                error(
                    "credential_shared_state_source_invalid",
                    "source is not valid JSON",
                )
            })?;
            let document = value.as_object().cloned().ok_or_else(|| {
                error(
                    "credential_shared_state_source_invalid",
                    "source root is not an object",
                )
            })?;
            (document, Some(version))
        }
        None => (Map::new(), None),
    };
    let state = extract(&document)?;
    Ok(Source {
        id,
        path,
        document,
        state,
        version,
    })
}

fn sources(
    home: &Path,
    account_root: &Path,
    current_profile: Option<&Path>,
) -> Result<Vec<Source>, String> {
    let mut sources = vec![read_source("default".into(), home.join(STATE_FILE))?];
    let mut entries: Vec<_> = std::fs::read_dir(account_root)
        .map_err(|source| {
            error(
                "credential_shared_state_io",
                &format!("account discovery failed: {source}"),
            )
        })?
        .collect::<Result<_, _>>()
        .map_err(|source| {
            error(
                "credential_shared_state_io",
                &format!("account discovery entry failed: {source}"),
            )
        })?;
    entries.sort_by_key(std::fs::DirEntry::file_name);
    let mut found_current = current_profile.is_none();
    for entry in entries {
        let Some(name) = entry.file_name().to_str().map(ToOwned::to_owned) else {
            continue;
        };
        if !name.starts_with("claude-") {
            continue;
        }
        let is_current = current_profile == Some(entry.path().as_path());
        let metadata = match std::fs::symlink_metadata(entry.path()) {
            Ok(metadata) => metadata,
            Err(source) => {
                return Err(error(
                    "credential_directory_untrusted",
                    &format!("profile inspection failed: {source}"),
                ));
            }
        };
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || metadata.uid() != unsafe { libc::geteuid() }
        {
            return Err(error(
                "credential_directory_untrusted",
                "profile is not a real owned directory",
            ));
        }
        found_current |= is_current;
        sources.push(read_source(name, entry.path().join(STATE_FILE))?);
    }
    if !found_current {
        return Err(error(
            "credential_directory_untrusted",
            "current profile disappeared during discovery",
        ));
    }
    Ok(sources)
}

fn parse_manifest(bytes: &[u8]) -> Result<Manifest, String> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| {
        error(
            "credential_shared_state_storage_untrusted",
            "authority is not valid JSON",
        )
    })?;
    let object = value.as_object().ok_or_else(|| {
        error(
            "credential_shared_state_storage_untrusted",
            "authority root is not an object",
        )
    })?;
    if object.len() != 3
        || object.get("schemaVersion").and_then(Value::as_u64) != Some(SCHEMA_VERSION)
    {
        return Err(error(
            "credential_shared_state_storage_untrusted",
            "authority schema is unsupported",
        ));
    }
    let authority_value = object.get("authority").ok_or_else(|| {
        error(
            "credential_shared_state_storage_untrusted",
            "authority state is absent",
        )
    })?;
    let authority_document = authority_value.as_object().ok_or_else(|| {
        error(
            "credential_shared_state_storage_untrusted",
            "authority state is invalid",
        )
    })?;
    let authority = extract(authority_document).map_err(|_| {
        error(
            "credential_shared_state_storage_untrusted",
            "authority state is invalid",
        )
    })?;
    if state_value(&authority) != *authority_value {
        return Err(error(
            "credential_shared_state_storage_untrusted",
            "authority contains unreviewed fields",
        ));
    }
    let sources = object
        .get("sources")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            error(
                "credential_shared_state_storage_untrusted",
                "authority sources are invalid",
            )
        })?
        .iter()
        .map(|value| value.as_str().map(ToOwned::to_owned))
        .collect::<Option<BTreeSet<_>>>()
        .ok_or_else(|| {
            error(
                "credential_shared_state_storage_untrusted",
                "authority sources are invalid",
            )
        })?;
    if sources
        .iter()
        .any(|source| source != "default" && !source.starts_with("claude-"))
    {
        return Err(error(
            "credential_shared_state_storage_untrusted",
            "authority source identity is invalid",
        ));
    }
    Ok(Manifest { authority, sources })
}

fn read_manifest(account_root: &Path) -> Result<(Manifest, Option<FileGeneration>), String> {
    let Some((bytes, version)) = read_file(
        &account_root.join(MANIFEST_FILE),
        "credential_shared_state_storage_untrusted",
    )?
    else {
        return Ok((Manifest::default(), None));
    };
    if version.mode & 0o077 != 0 {
        return Err(error(
            "credential_shared_state_storage_untrusted",
            "authority is not owner-only",
        ));
    }
    Ok((parse_manifest(&bytes)?, Some(version)))
}

fn version(path: &Path, code: &str) -> Result<Option<FileGeneration>, String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => trusted_version(&metadata, code).map(Some),
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(source) => Err(error(
            "credential_shared_state_io",
            &format!("reinspection failed: {source}"),
        )),
    }
}

fn unchanged(path: &Path, expected: Option<FileGeneration>, code: &str) -> Result<(), String> {
    if version(path, code)? == expected {
        return Ok(());
    }
    Err(error(
        "credential_shared_state_retry",
        "changed during convergence",
    ))
}

fn pretty(value: &Value) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec_pretty(value)
        .map_err(|_| error("credential_shared_state_io", "serialization failed"))?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn manifest_value(authority: &SharedState, sources: &BTreeSet<String>) -> Value {
    json!({
        "schemaVersion": SCHEMA_VERSION,
        "authority": state_value(authority),
        "sources": sources,
    })
}

fn converge_once(
    home: &Path,
    account_root: &Path,
    current_profile: Option<&Path>,
    fail_after: Option<usize>,
) -> Result<(), String> {
    let (manifest, manifest_version) = read_manifest(account_root)?;
    let sources = sources(home, account_root, current_profile)?;
    let baseline = manifest.authority;
    let mut authority = baseline.clone();
    let mut changed: Vec<_> = sources
        .iter()
        .filter(|source| source.version.is_some())
        .filter(|source| {
            if manifest.sources.contains(&source.id) {
                source.state != baseline
            } else {
                !source.state.is_empty()
            }
        })
        .collect();
    changed.sort_by(|left, right| {
        left.version
            .map(FileGeneration::order)
            .cmp(&right.version.map(FileGeneration::order))
            .then_with(|| left.id.cmp(&right.id))
    });
    for source in changed {
        apply_delta(
            &mut authority,
            &baseline,
            &source.state,
            manifest.sources.contains(&source.id),
        );
    }
    if manifest_version.is_none() && authority.is_empty() {
        return Ok(());
    }

    let source_ids: BTreeSet<String> = sources.iter().map(|source| source.id.clone()).collect();
    let mut writes = Vec::new();
    for source in &sources {
        if source.state == authority {
            continue;
        }
        let mut document = source.document.clone();
        apply(&mut document, &authority);
        writes.push(WritePlan {
            path: source.path.clone(),
            bytes: pretty(&Value::Object(document))?,
            expected: source.version,
        });
    }
    let next_manifest = manifest_value(&authority, &source_ids);
    let prior_manifest = manifest_value(&baseline, &manifest.sources);
    let manifest_write = (next_manifest != prior_manifest)
        .then(|| {
            pretty(&next_manifest).map(|bytes| WritePlan {
                path: account_root.join(MANIFEST_FILE),
                bytes,
                expected: manifest_version,
            })
        })
        .transpose()?;

    for source in &sources {
        unchanged(
            &source.path,
            source.version,
            "credential_shared_state_source_untrusted",
        )?;
    }
    unchanged(
        &account_root.join(MANIFEST_FILE),
        manifest_version,
        "credential_shared_state_storage_untrusted",
    )?;

    let mut transaction = OverlayTransaction::default();
    let mut fault = FaultInjection {
        fail_after,
        mutations: 0,
    };
    for write in writes.into_iter().chain(manifest_write) {
        let code = if write.path.ends_with(MANIFEST_FILE) {
            "credential_shared_state_storage_untrusted"
        } else {
            "credential_shared_state_source_untrusted"
        };
        unchanged(&write.path, write.expected, code)?;
        atomic_replace_regular_file(
            &write.path,
            &mut transaction,
            &mut fault,
            |file| {
                file.write_all(&write.bytes).map_err(|source| {
                    error(
                        "credential_shared_state_io",
                        &format!("write failed: {source}"),
                    )
                })
            },
            || unchanged(&write.path, write.expected, code),
        )?;
    }
    transaction.commit()
}

pub(super) fn converge(
    home: &Path,
    account_root: &Path,
    current_profile: Option<&Path>,
    fail_after: Option<usize>,
) -> Result<(), String> {
    let account_root = require_owned_real_directory(account_root, "account root")?;
    let current_profile = current_profile
        .map(|path| {
            let profile = require_owned_real_directory(path, "current profile")?;
            if profile.parent() != Some(account_root.as_path())
                || !profile
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("claude-"))
            {
                return Err(error(
                    "credential_directory_untrusted",
                    "current profile is outside the Claude account root",
                ));
            }
            Ok(profile)
        })
        .transpose()?;
    let _lock = lock_profile(&account_root, "claude-shared-state-v1")?;
    let mut retry = None;
    for _ in 0..MAX_ATTEMPTS {
        match converge_once(home, &account_root, current_profile.as_deref(), fail_after) {
            Err(error) if error.starts_with("credential_shared_state_retry:") => {
                retry = Some(error);
            }
            result => return result,
        }
    }
    Err(retry.unwrap_or_else(|| {
        error(
            "credential_shared_state_retry_exhausted",
            "kept changing during convergence",
        )
    }))
}

#[cfg(test)]
#[path = "claude_shared_state_tests.rs"]
mod tests;
