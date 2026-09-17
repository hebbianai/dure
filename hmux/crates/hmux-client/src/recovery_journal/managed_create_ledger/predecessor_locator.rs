use super::super::{
    ensure_same_open_file, open_private_existing, open_private_new, private_path_exists,
    replace_private_file, request_fingerprint, sync_private_directory,
};
use super::{LEDGER_SHARDS, MAX_SHARD_RECORDS, ManagedCreateAdmissionError, shard_index};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

const LOCATOR_SCHEMA_VERSION: u16 = 1;
const LOCATOR_KEY_BYTES: usize = 32;
const MAX_LOCATOR_NODE_BYTES: u64 = 1_024;
const MAX_LOCATOR_NODE_READS: usize = 32;
const MAX_LOCATOR_RECORDS: usize = LEDGER_SHARDS * MAX_SHARD_RECORDS;

#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct ReadCounts {
    pub(super) shard_files: usize,
    pub(super) nodes: usize,
}

#[cfg(test)]
thread_local! {
    static MEASURED_READS: std::cell::Cell<Option<ReadCounts>> = const {
        std::cell::Cell::new(None)
    };
}

#[cfg(all(test, unix))]
pub(super) fn measure_reads<T>(operation: impl FnOnce() -> T) -> (T, ReadCounts) {
    MEASURED_READS.with(|reads| {
        assert_eq!(
            reads.replace(Some(ReadCounts {
                shard_files: 0,
                nodes: 0
            })),
            None
        );
        let result = operation();
        let measured = reads.replace(None).unwrap();
        (result, measured)
    })
}

#[derive(Clone, Debug)]
pub(super) struct Coverage {
    shards: Vec<ShardManifest>,
}

impl Coverage {
    pub(super) fn from_receipt(
        shards: Vec<ShardManifest>,
    ) -> Result<Self, ManagedCreateAdmissionError> {
        if shards.len() != LEDGER_SHARDS {
            return Err(invalid("predecessor locator shard coverage changed"));
        }
        for manifest in &shards {
            validate_manifest(manifest)?;
        }
        Ok(Self { shards })
    }

    pub(super) fn receipt_shards(&self) -> Vec<ShardManifest> {
        self.shards.clone()
    }

    fn manifest(&self, index: usize) -> &ShardManifest {
        &self.shards[index]
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ShardManifest {
    bytes: u64,
    records: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    root: Option<NodeRef>,
}

impl ShardManifest {
    fn empty() -> Self {
        Self {
            bytes: 0,
            records: 0,
            root: None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NodeRef {
    offset: u64,
    length: u16,
    digest: String,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub(super) struct Entry {
    target_key: [u8; LOCATOR_KEY_BYTES],
    source_shard: u16,
    source_record_key: [u8; LOCATOR_KEY_BYTES],
    conflict: bool,
}

impl Entry {
    pub(super) fn new(
        target_key: &str,
        source_shard: usize,
        source_record_key: &str,
    ) -> Result<Self, ManagedCreateAdmissionError> {
        let source_shard = source_shard
            .try_into()
            .map_err(|_| invalid("predecessor locator source shard changed"))?;
        let source_record_key = parse_key(source_record_key, "source record key")?;
        if shard_index(source_record_key.as_str()).map_err(ManagedCreateAdmissionError::Ledger)?
            != usize::from(source_shard)
        {
            return Err(invalid("predecessor locator source changed"));
        }
        Ok(Self {
            target_key: parse_key(target_key, "target key")?.bytes,
            source_shard,
            source_record_key: source_record_key.bytes,
            conflict: false,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum LocatedAuthority {
    Edge {
        source_shard: usize,
        source_record_key: String,
    },
    Conflict,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct LocatorKey {
    bytes: [u8; LOCATOR_KEY_BYTES],
}

impl LocatorKey {
    fn as_str(&self) -> &str {
        std::str::from_utf8(&self.bytes).expect("validated locator key must remain ASCII")
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Node {
    schema_version: u16,
    target_key: String,
    authority: NodeAuthority,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    left: Option<NodeRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    right: Option<NodeRef>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum NodeAuthority {
    Edge {
        source_shard: u16,
        source_record_key: String,
    },
    Conflict,
}

pub(super) fn publish(
    directory: &Path,
    entries: &mut Vec<Entry>,
) -> Result<Coverage, ManagedCreateAdmissionError> {
    entries.sort_unstable();
    collapse(entries);
    let mut manifests = Vec::with_capacity(LEDGER_SHARDS);
    let mut start = 0;
    for index in 0..LEDGER_SHARDS {
        let mut end = start;
        while end < entries.len() && target_shard(&entries[end].target_key)? == index {
            end += 1;
        }
        manifests.push(if start == end {
            ShardManifest::empty()
        } else {
            write_shard(directory, index, &entries[start..end])?
        });
        start = end;
    }
    if start != entries.len() {
        return Err(invalid("predecessor locator target shard changed"));
    }
    sync_private_directory(directory).map_err(ManagedCreateAdmissionError::Ledger)?;
    Coverage::from_receipt(manifests)
}

pub(super) fn lookup(
    directory: &Path,
    coverage: &Coverage,
    target_key: &str,
) -> Result<Option<LocatedAuthority>, ManagedCreateAdmissionError> {
    let target_key = parse_key(target_key, "target key")?;
    let index = shard_index(target_key.as_str()).map_err(ManagedCreateAdmissionError::Ledger)?;
    let manifest = coverage.manifest(index);
    let Some(mut node_ref) = manifest.root.clone() else {
        return Ok(None);
    };
    let path = shard_path(directory, index);
    if !private_path_exists(&path).map_err(ManagedCreateAdmissionError::Ledger)? {
        return Err(invalid("predecessor locator shard disappeared"));
    }
    let mut file = open_private_existing(&path, "managed create predecessor locator shard")
        .map_err(ManagedCreateAdmissionError::Ledger)?;
    note_shard_file_read();
    let metadata = file
        .metadata()
        .map_err(|_| invalid("predecessor locator shard is unreadable"))?;
    if metadata.len() != manifest.bytes {
        return Err(invalid("predecessor locator shard size changed"));
    }
    let result = (|| {
        for _ in 0..MAX_LOCATOR_NODE_READS {
            let node = read_node(&mut file, manifest, index, &node_ref)?;
            match target_key.as_str().cmp(node.target_key.as_str()) {
                Ordering::Less => {
                    let Some(next) = node.left else {
                        return Ok(None);
                    };
                    node_ref = next;
                }
                Ordering::Greater => {
                    let Some(next) = node.right else {
                        return Ok(None);
                    };
                    node_ref = next;
                }
                Ordering::Equal => {
                    return match node.authority {
                        NodeAuthority::Edge {
                            source_shard,
                            source_record_key,
                        } => Ok(Some(LocatedAuthority::Edge {
                            source_shard: usize::from(source_shard),
                            source_record_key,
                        })),
                        NodeAuthority::Conflict => Ok(Some(LocatedAuthority::Conflict)),
                    };
                }
            }
        }
        Err(invalid("predecessor locator depth exceeded"))
    })();
    ensure_same_open_file(&path, &file).map_err(ManagedCreateAdmissionError::Ledger)?;
    result
}

pub(super) fn shard_path(directory: &Path, index: usize) -> PathBuf {
    directory.join(format!("predecessor_locator_{index:02x}.bin"))
}

#[cfg(all(test, unix))]
pub(super) fn root_offset(coverage: &Coverage, index: usize) -> u64 {
    coverage.manifest(index).root.as_ref().unwrap().offset
}

fn collapse(entries: &mut Vec<Entry>) {
    let mut read = 0;
    let mut write = 0;
    while read < entries.len() {
        let mut end = read + 1;
        while end < entries.len() && entries[end].target_key == entries[read].target_key {
            end += 1;
        }
        entries[read].conflict = end - read > 1;
        if write != read {
            entries[write] = entries[read].clone();
        }
        write += 1;
        read = end;
    }
    entries.truncate(write);
}

fn write_shard(
    directory: &Path,
    index: usize,
    entries: &[Entry],
) -> Result<ShardManifest, ManagedCreateAdmissionError> {
    let path = shard_path(directory, index);
    let temporary = directory.join(format!(".predecessor_locator_{index:02x}.tmp"));
    if private_path_exists(&temporary).map_err(ManagedCreateAdmissionError::Ledger)? {
        let stale = open_private_existing(
            &temporary,
            "managed create predecessor locator temporary shard",
        )
        .map_err(ManagedCreateAdmissionError::Ledger)?;
        ensure_same_open_file(&temporary, &stale).map_err(ManagedCreateAdmissionError::Ledger)?;
        fs::remove_file(&temporary)
            .map_err(|_| failed("stale predecessor locator shard removal failed"))?;
    }
    let write_result = (|| {
        let mut file = open_private_new(&temporary).map_err(ManagedCreateAdmissionError::Ledger)?;
        let root = write_tree(&mut file, entries)?
            .ok_or_else(|| invalid("non-empty predecessor locator shard lost its root"))?;
        file.sync_all()
            .map_err(|_| failed("predecessor locator shard sync failed"))?;
        let bytes = file
            .metadata()
            .map_err(|_| failed("predecessor locator shard metadata failed"))?
            .len();
        let records = entries
            .len()
            .try_into()
            .map_err(|_| capacity("predecessor locator shard has too many records"))?;
        let manifest = ShardManifest {
            bytes,
            records,
            root: Some(root),
        };
        validate_manifest(&manifest)?;
        ensure_same_open_file(&temporary, &file).map_err(ManagedCreateAdmissionError::Ledger)?;
        if private_path_exists(&path).map_err(ManagedCreateAdmissionError::Ledger)? {
            let existing = open_private_existing(&path, "managed create predecessor locator shard")
                .map_err(ManagedCreateAdmissionError::Ledger)?;
            ensure_same_open_file(&path, &existing).map_err(ManagedCreateAdmissionError::Ledger)?;
        }
        drop(file);
        replace_private_file(&temporary, &path)
            .map_err(|_| failed("predecessor locator shard publish failed"))?;
        Ok(manifest)
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result
}

fn write_tree(
    file: &mut fs::File,
    entries: &[Entry],
) -> Result<Option<NodeRef>, ManagedCreateAdmissionError> {
    if entries.is_empty() {
        return Ok(None);
    }
    let middle = entries.len() / 2;
    let left = write_tree(file, &entries[..middle])?;
    let right = write_tree(file, &entries[middle + 1..])?;
    let entry = &entries[middle];
    let node = Node {
        schema_version: LOCATOR_SCHEMA_VERSION,
        target_key: key_string(&entry.target_key),
        authority: if entry.conflict {
            NodeAuthority::Conflict
        } else {
            NodeAuthority::Edge {
                source_shard: entry.source_shard,
                source_record_key: key_string(&entry.source_record_key),
            }
        },
        left,
        right,
    };
    let payload = serde_json::to_vec(&node)
        .map_err(|_| failed("predecessor locator node serialization failed"))?;
    if payload.len() as u64 > MAX_LOCATOR_NODE_BYTES {
        return Err(capacity("predecessor locator node is too large"));
    }
    let offset = file
        .stream_position()
        .map_err(|_| failed("predecessor locator node offset failed"))?;
    file.write_all(&payload)
        .map_err(|_| failed("predecessor locator shard write failed"))?;
    Ok(Some(NodeRef {
        offset,
        length: payload
            .len()
            .try_into()
            .map_err(|_| capacity("predecessor locator node is too large"))?,
        digest: node_digest(&payload)?,
    }))
}

fn read_node(
    file: &mut fs::File,
    manifest: &ShardManifest,
    index: usize,
    node_ref: &NodeRef,
) -> Result<Node, ManagedCreateAdmissionError> {
    note_node_read();
    validate_node_ref(node_ref, manifest.bytes)?;
    file.seek(SeekFrom::Start(node_ref.offset))
        .map_err(|_| invalid("predecessor locator node seek failed"))?;
    let mut payload = vec![0; usize::from(node_ref.length)];
    file.read_exact(&mut payload)
        .map_err(|_| invalid("predecessor locator node is unreadable"))?;
    if node_digest(&payload)? != node_ref.digest {
        return Err(invalid("predecessor locator node digest changed"));
    }
    let node: Node = serde_json::from_slice(&payload)
        .map_err(|_| invalid("predecessor locator node is malformed"))?;
    validate_node(&node, manifest.bytes, index)?;
    Ok(node)
}

fn validate_manifest(manifest: &ShardManifest) -> Result<(), ManagedCreateAdmissionError> {
    let records = usize::try_from(manifest.records)
        .map_err(|_| invalid("predecessor locator record count changed"))?;
    if records > MAX_LOCATOR_RECORDS {
        return Err(invalid("predecessor locator record count changed"));
    }
    match (&manifest.root, records, manifest.bytes) {
        (None, 0, 0) => Ok(()),
        (Some(root), records, bytes)
            if records > 0 && bytes > 0 && bytes <= records as u64 * MAX_LOCATOR_NODE_BYTES =>
        {
            validate_node_ref(root, bytes)?;
            Ok(())
        }
        _ => Err(invalid("predecessor locator shard manifest changed")),
    }
}

fn validate_node(
    node: &Node,
    manifest_bytes: u64,
    index: usize,
) -> Result<(), ManagedCreateAdmissionError> {
    if node.schema_version != LOCATOR_SCHEMA_VERSION {
        return Err(invalid("predecessor locator node schema changed"));
    }
    let target_key = parse_key(&node.target_key, "target key")?;
    if shard_index(target_key.as_str()).map_err(ManagedCreateAdmissionError::Ledger)? != index {
        return Err(invalid("predecessor locator target shard changed"));
    }
    if let NodeAuthority::Edge {
        source_shard,
        source_record_key,
    } = &node.authority
    {
        let source_key = parse_key(source_record_key, "source record key")?;
        if usize::from(*source_shard) >= LEDGER_SHARDS
            || shard_index(source_key.as_str()).map_err(ManagedCreateAdmissionError::Ledger)?
                != usize::from(*source_shard)
        {
            return Err(invalid("predecessor locator source changed"));
        }
    }
    if let Some(left) = &node.left {
        validate_node_ref(left, manifest_bytes)?;
    }
    if let Some(right) = &node.right {
        validate_node_ref(right, manifest_bytes)?;
    }
    Ok(())
}

fn validate_node_ref(
    node: &NodeRef,
    manifest_bytes: u64,
) -> Result<(), ManagedCreateAdmissionError> {
    let length = u64::from(node.length);
    if length == 0
        || length > MAX_LOCATOR_NODE_BYTES
        || node
            .offset
            .checked_add(length)
            .is_none_or(|end| end > manifest_bytes)
        || node.digest.len() != 64
        || !node
            .digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(invalid("predecessor locator node reference changed"));
    }
    Ok(())
}

fn parse_key(value: &str, label: &str) -> Result<LocatorKey, ManagedCreateAdmissionError> {
    let value = value.as_bytes();
    if value.len() != LOCATOR_KEY_BYTES
        || !value
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
    {
        return Err(invalid(&format!("predecessor locator {label} changed")));
    }
    let mut bytes = [0; LOCATOR_KEY_BYTES];
    bytes.copy_from_slice(value);
    Ok(LocatorKey { bytes })
}

fn target_shard(key: &[u8; LOCATOR_KEY_BYTES]) -> Result<usize, ManagedCreateAdmissionError> {
    let key = LocatorKey { bytes: *key };
    shard_index(key.as_str()).map_err(ManagedCreateAdmissionError::Ledger)
}

fn key_string(value: &[u8; LOCATOR_KEY_BYTES]) -> String {
    value.iter().map(|byte| char::from(*byte)).collect()
}

fn node_digest(payload: &[u8]) -> Result<String, ManagedCreateAdmissionError> {
    let payload = std::str::from_utf8(payload)
        .map_err(|_| invalid("predecessor locator node is not utf-8"))?;
    Ok(request_fingerprint(&[
        "managed-create-predecessor-locator-node-v1",
        payload,
    ]))
}

fn invalid(detail: &str) -> ManagedCreateAdmissionError {
    ManagedCreateAdmissionError::Ledger(format!("hmux_managed_create_successor_invalid: {detail}"))
}

fn failed(detail: &str) -> ManagedCreateAdmissionError {
    ManagedCreateAdmissionError::Ledger(format!("hmux_managed_create_successor_failed: {detail}"))
}

fn capacity(detail: &str) -> ManagedCreateAdmissionError {
    ManagedCreateAdmissionError::Ledger(format!("hmux_managed_create_successor_capacity: {detail}"))
}

#[cfg(test)]
fn note_shard_file_read() {
    MEASURED_READS.with(|reads| {
        if let Some(mut current) = reads.get() {
            current.shard_files += 1;
            reads.set(Some(current));
        }
    });
}

#[cfg(not(test))]
fn note_shard_file_read() {}

#[cfg(test)]
fn note_node_read() {
    MEASURED_READS.with(|reads| {
        if let Some(mut current) = reads.get() {
            current.nodes += 1;
            reads.set(Some(current));
        }
    });
}

#[cfg(not(test))]
fn note_node_read() {}

#[cfg(test)]
mod tests {
    use super::super::super::MAX_RECORD_BYTES;
    use super::super::{
        ManagedCreateSuccessorPredecessorCoverageReceipt,
        SUCCESSOR_PREDECESSOR_COVERAGE_SCHEMA_VERSION,
    };
    use super::*;

    #[test]
    fn current_predecessor_coverage_receipt_stays_bounded_with_every_locator_shard() {
        let records = u32::try_from(MAX_LOCATOR_RECORDS).unwrap();
        let bytes = u64::from(records) * MAX_LOCATOR_NODE_BYTES;
        let locator_shards = (0..LEDGER_SHARDS)
            .map(|_| ShardManifest {
                bytes,
                records,
                root: Some(NodeRef {
                    offset: bytes - MAX_LOCATOR_NODE_BYTES,
                    length: MAX_LOCATOR_NODE_BYTES.try_into().unwrap(),
                    digest: "f".repeat(64),
                }),
            })
            .collect::<Vec<_>>();
        Coverage::from_receipt(locator_shards.clone()).unwrap();

        let payload = serde_json::to_vec(&ManagedCreateSuccessorPredecessorCoverageReceipt {
            schema_version: SUCCESSOR_PREDECESSOR_COVERAGE_SCHEMA_VERSION,
            legacy_source_shards_by_target: Vec::new(),
            locator_shards,
        })
        .unwrap();

        assert!(
            payload.len() as u64 <= MAX_RECORD_BYTES,
            "the cutover receipt must remain a bounded marker at maximum locator metadata width",
        );
    }
}
