use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use subtle::ConstantTimeEq;

#[cfg(test)]
use std::path::PathBuf;

use super::{
    create_owned_file, io_error, open_owned_file, sync_directory, validate_owned_directory,
    ExclusiveJournalAccess, StoreResult,
};

type HmacSha256 = Hmac<Sha256>;

const COMPACTION_INTENT_FILE: &str = "decisions-v2.authority-intent";
const COMPACTION_INTENT_TARGET_FILE: &str = ".decisions-v2.authority-intent-target";
const COMPACTION_TARGET_FILE: &str = ".decisions-v2.authority-target";

const AUTHORITY_COMMITMENT_BYTES: u64 = 32;
const AUTHORITY_FRAME_MAGIC: &[u8; 8] = b"DUREPPA2";
const AUTHORITY_FRAME_VERSION: u16 = 1;
const AUTHORITY_FRAME_BYTES: usize = 208;
const AUTHORITY_FRAME_MAC_OFFSET: usize = AUTHORITY_FRAME_BYTES - 32;
// One baseline pin, every lifetime event, a worst-case compaction before each
// regular event, and the 1,024-key emergency-disable reserve all fit without
// making the authority file unbounded.
const MAX_AUTHORITY_FRAMES: u64 = 18_433;
const MAX_AUTHORITY_ANCHOR_BYTES: u64 =
    AUTHORITY_COMMITMENT_BYTES + MAX_AUTHORITY_FRAMES * AUTHORITY_FRAME_BYTES as u64;

const AUTHORITY_INTENT_MAGIC: &[u8; 8] = b"DUREPPI2";
const AUTHORITY_INTENT_VERSION: u16 = 1;
const AUTHORITY_INTENT_BYTES: usize = 292;
const AUTHORITY_INTENT_MAC_OFFSET: usize = AUTHORITY_INTENT_BYTES - 32;

#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum CompactionFaultStage {
    TargetWrite,
    TargetSync,
    TargetDirectorySync,
    IntentWrite,
    IntentSync,
    IntentTargetDirectorySync,
    IntentPublishRename,
    IntentPublishDirectorySync,
    AnchorWrite,
    AnchorSync,
    SourceRevalidate,
    PublishRename,
    PublishDirectorySync,
    IntentCleanup,
    IntentCleanupDirectorySync,
}

#[cfg(test)]
std::thread_local! {
    static COMPACTION_FAULT: std::cell::Cell<Option<CompactionFaultStage>> = const {
        std::cell::Cell::new(None)
    };
    static AUTHORITY_FAULT: std::cell::Cell<Option<CompactionFaultStage>> = const {
        std::cell::Cell::new(None)
    };
    static ACTIVE_MUTATION_KIND: std::cell::Cell<Option<JournalMutationKind>> = const {
        std::cell::Cell::new(None)
    };
}

#[cfg(test)]
pub(super) fn fail_next_compaction_at(stage: CompactionFaultStage) {
    COMPACTION_FAULT.with(|fault| fault.set(Some(stage)));
}

#[cfg(test)]
pub(super) fn fail_next_authority_at(stage: CompactionFaultStage) {
    AUTHORITY_FAULT.with(|fault| fault.set(Some(stage)));
}

fn inject_compaction_fault(stage: CompactionFaultStageForBuild) -> StoreResult<()> {
    #[cfg(test)]
    {
        let requested = match stage {
            CompactionFaultStageForBuild::TargetWrite => CompactionFaultStage::TargetWrite,
            CompactionFaultStageForBuild::TargetSync => CompactionFaultStage::TargetSync,
            CompactionFaultStageForBuild::TargetDirectorySync => {
                CompactionFaultStage::TargetDirectorySync
            }
            CompactionFaultStageForBuild::IntentWrite => CompactionFaultStage::IntentWrite,
            CompactionFaultStageForBuild::IntentSync => CompactionFaultStage::IntentSync,
            CompactionFaultStageForBuild::IntentTargetDirectorySync => {
                CompactionFaultStage::IntentTargetDirectorySync
            }
            CompactionFaultStageForBuild::IntentPublishRename => {
                CompactionFaultStage::IntentPublishRename
            }
            CompactionFaultStageForBuild::IntentPublishDirectorySync => {
                CompactionFaultStage::IntentPublishDirectorySync
            }
            CompactionFaultStageForBuild::AnchorWrite => CompactionFaultStage::AnchorWrite,
            CompactionFaultStageForBuild::AnchorSync => CompactionFaultStage::AnchorSync,
            CompactionFaultStageForBuild::SourceRevalidate => {
                CompactionFaultStage::SourceRevalidate
            }
            CompactionFaultStageForBuild::PublishRename => CompactionFaultStage::PublishRename,
            CompactionFaultStageForBuild::PublishDirectorySync => {
                CompactionFaultStage::PublishDirectorySync
            }
            CompactionFaultStageForBuild::IntentCleanup => CompactionFaultStage::IntentCleanup,
            CompactionFaultStageForBuild::IntentCleanupDirectorySync => {
                CompactionFaultStage::IntentCleanupDirectorySync
            }
        };
        let authority_fault = AUTHORITY_FAULT.with(|fault| {
            let current = fault.get();
            if current == Some(requested) {
                fault.set(None);
                true
            } else {
                false
            }
        });
        let compaction_fault = ACTIVE_MUTATION_KIND.with(|kind| {
            kind.get() == Some(JournalMutationKind::Compaction)
                && COMPACTION_FAULT.with(|fault| {
                    let current = fault.get();
                    if current == Some(requested) {
                        fault.set(None);
                        true
                    } else {
                        false
                    }
                })
        });
        if authority_fault || compaction_fault {
            return Err(super::PluginPermissionStoreError::new(
                "plugin_permission_store_io",
                format!("injected permission authority fault at {requested:?}"),
            ));
        }
    }
    let _ = stage;
    Ok(())
}

#[derive(Clone, Copy)]
enum CompactionFaultStageForBuild {
    TargetWrite,
    TargetSync,
    TargetDirectorySync,
    IntentWrite,
    IntentSync,
    IntentTargetDirectorySync,
    IntentPublishRename,
    IntentPublishDirectorySync,
    AnchorWrite,
    AnchorSync,
    SourceRevalidate,
    PublishRename,
    PublishDirectorySync,
    IntentCleanup,
    IntentCleanupDirectorySync,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct JournalAuthorityState {
    pub(super) format_generation: u64,
    pub(super) logical_count: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub(super) enum JournalMutationKind {
    BaselineMigration = 1,
    EventAppend = 2,
    Compaction = 3,
}

#[cfg(test)]
struct ActiveMutationKindGuard(Option<JournalMutationKind>);

#[cfg(test)]
impl ActiveMutationKindGuard {
    fn enter(kind: JournalMutationKind) -> Self {
        Self(ACTIVE_MUTATION_KIND.with(|active| active.replace(Some(kind))))
    }
}

#[cfg(test)]
impl Drop for ActiveMutationKindGuard {
    fn drop(&mut self) {
        ACTIVE_MUTATION_KIND.with(|active| active.set(self.0));
    }
}

impl JournalMutationKind {
    fn decode(value: u8) -> StoreResult<Self> {
        match value {
            1 => Ok(Self::BaselineMigration),
            2 => Ok(Self::EventAppend),
            3 => Ok(Self::Compaction),
            _ => Err(authority_invalid(
                "authority frame has an unknown mutation kind",
            )),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct JournalAuthorityIdentity {
    pub(super) sha256: [u8; 32],
    pub(super) len: u64,
    pub(super) state: JournalAuthorityState,
}

#[derive(Clone, Copy)]
pub(super) struct JournalAuthoritySnapshot<'a> {
    pub(super) bytes: &'a [u8],
    pub(super) state: JournalAuthorityState,
}

#[derive(Clone, Copy)]
pub(super) struct JournalAuthorityReplacement<'a> {
    pub(super) source: JournalAuthoritySnapshot<'a>,
    pub(super) target: JournalAuthoritySnapshot<'a>,
    pub(super) mutation_kind: JournalMutationKind,
}

impl JournalAuthorityIdentity {
    pub(super) fn from_bytes(bytes: &[u8], state: JournalAuthorityState) -> StoreResult<Self> {
        Ok(Self {
            sha256: Sha256::digest(bytes).into(),
            len: u64::try_from(bytes.len())
                .map_err(|_| authority_invalid("journal length overflow"))?,
            state,
        })
    }

    pub(super) fn matches(&self, bytes: &[u8]) -> bool {
        bytes.len() as u64 == self.len
            && bool::from(self.sha256.ct_eq(Sha256::digest(bytes).as_slice()))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct AuthorityFrame {
    sequence: u64,
    previous_mac: [u8; 32],
    source: JournalAuthorityIdentity,
    target: JournalAuthorityIdentity,
    mutation_kind: JournalMutationKind,
    mac: [u8; 32],
}

impl AuthorityFrame {
    fn new(
        sequence: u64,
        previous_mac: [u8; 32],
        source: JournalAuthorityIdentity,
        target: JournalAuthorityIdentity,
        mutation_kind: JournalMutationKind,
        authority_key: &[u8; 32],
    ) -> StoreResult<Self> {
        validate_transition(sequence, source, target, mutation_kind)?;
        let mut frame = Self {
            sequence,
            previous_mac,
            source,
            target,
            mutation_kind,
            mac: [0; 32],
        };
        let encoded = frame.encode_without_mac();
        frame.mac = hmac(authority_key, &encoded[..AUTHORITY_FRAME_MAC_OFFSET])?;
        Ok(frame)
    }

    fn encode(&self) -> [u8; AUTHORITY_FRAME_BYTES] {
        let mut bytes = self.encode_without_mac();
        bytes[AUTHORITY_FRAME_MAC_OFFSET..].copy_from_slice(&self.mac);
        bytes
    }

    fn encode_without_mac(&self) -> [u8; AUTHORITY_FRAME_BYTES] {
        let mut bytes = [0; AUTHORITY_FRAME_BYTES];
        bytes[0..8].copy_from_slice(AUTHORITY_FRAME_MAGIC);
        bytes[8..10].copy_from_slice(&AUTHORITY_FRAME_VERSION.to_be_bytes());
        bytes[10..12].copy_from_slice(&(AUTHORITY_FRAME_BYTES as u16).to_be_bytes());
        bytes[12] = self.mutation_kind as u8;
        bytes[24..32].copy_from_slice(&self.sequence.to_be_bytes());
        bytes[32..64].copy_from_slice(&self.previous_mac);
        encode_identity(&mut bytes[64..120], self.source);
        encode_identity(&mut bytes[120..176], self.target);
        bytes
    }

    fn decode(bytes: &[u8], authority_key: &[u8; 32]) -> StoreResult<Self> {
        if bytes.len() != AUTHORITY_FRAME_BYTES
            || &bytes[0..8] != AUTHORITY_FRAME_MAGIC
            || read_u16(&bytes[8..10]) != AUTHORITY_FRAME_VERSION
            || read_u16(&bytes[10..12]) as usize != AUTHORITY_FRAME_BYTES
            || bytes[13..24].iter().any(|byte| *byte != 0)
        {
            return Err(authority_invalid("authority frame has invalid framing"));
        }
        let expected_mac = hmac(authority_key, &bytes[..AUTHORITY_FRAME_MAC_OFFSET])?;
        if !bool::from(expected_mac.ct_eq(&bytes[AUTHORITY_FRAME_MAC_OFFSET..])) {
            return Err(authority_invalid("authority frame HMAC does not verify"));
        }
        let frame = Self {
            sequence: read_u64(&bytes[24..32]),
            previous_mac: bytes[32..64].try_into().expect("fixed frame slice"),
            source: decode_identity(&bytes[64..120]),
            target: decode_identity(&bytes[120..176]),
            mutation_kind: JournalMutationKind::decode(bytes[12])?,
            mac: bytes[AUTHORITY_FRAME_MAC_OFFSET..]
                .try_into()
                .expect("fixed frame MAC slice"),
        };
        validate_transition(
            frame.sequence,
            frame.source,
            frame.target,
            frame.mutation_kind,
        )?;
        Ok(frame)
    }
}

fn validate_transition(
    sequence: u64,
    source: JournalAuthorityIdentity,
    target: JournalAuthorityIdentity,
    mutation_kind: JournalMutationKind,
) -> StoreResult<()> {
    if sequence == 0 || sequence > MAX_AUTHORITY_FRAMES {
        return Err(authority_invalid(
            "authority sequence exceeds its hard bound",
        ));
    }
    match mutation_kind {
        JournalMutationKind::BaselineMigration => {
            if sequence != 1 || source != target {
                return Err(authority_invalid(
                    "baseline migration must be the first exact source pin",
                ));
            }
        }
        JournalMutationKind::EventAppend => {
            if target.state.format_generation != source.state.format_generation
                || target.state.logical_count
                    != source
                        .state
                        .logical_count
                        .checked_add(1)
                        .ok_or_else(|| authority_invalid("logical event count overflow"))?
                || target.sha256 == source.sha256
            {
                return Err(authority_invalid(
                    "event append authority transition is invalid",
                ));
            }
        }
        JournalMutationKind::Compaction => {
            if target.state.logical_count != source.state.logical_count
                || target.state.format_generation
                    != source
                        .state
                        .format_generation
                        .checked_add(1)
                        .ok_or_else(|| authority_invalid("journal format generation overflow"))?
                || target.sha256 == source.sha256
            {
                return Err(authority_invalid(
                    "compaction authority transition is invalid",
                ));
            }
        }
    }
    Ok(())
}

fn encode_identity(bytes: &mut [u8], identity: JournalAuthorityIdentity) {
    bytes[0..32].copy_from_slice(&identity.sha256);
    bytes[32..40].copy_from_slice(&identity.len.to_be_bytes());
    bytes[40..48].copy_from_slice(&identity.state.format_generation.to_be_bytes());
    bytes[48..56].copy_from_slice(&identity.state.logical_count.to_be_bytes());
}

fn decode_identity(bytes: &[u8]) -> JournalAuthorityIdentity {
    JournalAuthorityIdentity {
        sha256: bytes[0..32]
            .try_into()
            .expect("fixed identity digest slice"),
        len: read_u64(&bytes[32..40]),
        state: JournalAuthorityState {
            format_generation: read_u64(&bytes[40..48]),
            logical_count: read_u64(&bytes[48..56]),
        },
    }
}

fn read_u16(bytes: &[u8]) -> u16 {
    u16::from_be_bytes(bytes.try_into().expect("fixed u16 slice"))
}

fn read_u64(bytes: &[u8]) -> u64 {
    u64::from_be_bytes(bytes.try_into().expect("fixed u64 slice"))
}

fn hmac(authority_key: &[u8; 32], bytes: &[u8]) -> StoreResult<[u8; 32]> {
    let mut mac = HmacSha256::new_from_slice(authority_key)
        .map_err(|_| authority_invalid("authority HMAC key has an invalid length"))?;
    mac.update(bytes);
    Ok(mac.finalize().into_bytes().into())
}

#[derive(Clone, Copy, Debug)]
struct AuthorityTail {
    frame_count: u64,
    last_mac: [u8; 32],
    last_target: Option<JournalAuthorityIdentity>,
}

fn validate_anchor_bytes(bytes: &[u8], authority_key: &[u8; 32]) -> StoreResult<AuthorityTail> {
    if bytes.len() as u64 > MAX_AUTHORITY_ANCHOR_BYTES
        || bytes.len() < AUTHORITY_COMMITMENT_BYTES as usize
        || !(bytes.len() - AUTHORITY_COMMITMENT_BYTES as usize)
            .is_multiple_of(AUTHORITY_FRAME_BYTES)
    {
        return Err(authority_invalid(
            "authority anchor has an invalid or incomplete fixed frame tail",
        ));
    }
    let expected_commitment = Sha256::digest(authority_key);
    if !bool::from(bytes[..32].ct_eq(expected_commitment.as_slice())) {
        return Err(authority_invalid(
            "authority anchor commitment does not match its HMAC key",
        ));
    }
    let mut tail = AuthorityTail {
        frame_count: 0,
        last_mac: [0; 32],
        last_target: None,
    };
    for encoded in bytes[32..].chunks_exact(AUTHORITY_FRAME_BYTES) {
        let frame = AuthorityFrame::decode(encoded, authority_key)?;
        let expected_sequence = tail.frame_count + 1;
        if frame.sequence != expected_sequence
            || !bool::from(frame.previous_mac.ct_eq(&tail.last_mac))
            || tail
                .last_target
                .is_some_and(|previous| previous != frame.source)
        {
            return Err(authority_invalid(
                "authority frame breaks sequence, MAC, or journal identity continuity",
            ));
        }
        tail.frame_count = frame.sequence;
        tail.last_mac = frame.mac;
        tail.last_target = Some(frame.target);
    }
    Ok(tail)
}

fn read_anchor(lock: &File) -> StoreResult<Vec<u8>> {
    let length = lock
        .metadata()
        .map_err(|error| authority_io("inspect permission authority anchor", error))?
        .len();
    if length > MAX_AUTHORITY_ANCHOR_BYTES {
        return Err(authority_invalid("authority anchor exceeds its byte bound"));
    }
    let mut reader = lock;
    reader
        .seek(SeekFrom::Start(0))
        .map_err(|error| authority_io("seek permission authority anchor", error))?;
    let mut bytes = Vec::with_capacity(usize::try_from(length).unwrap_or(0));
    Read::by_ref(&mut reader)
        .take(MAX_AUTHORITY_ANCHOR_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| authority_io("read permission authority anchor", error))?;
    if bytes.len() as u64 > MAX_AUTHORITY_ANCHOR_BYTES {
        return Err(authority_invalid("authority anchor exceeds its byte bound"));
    }
    Ok(bytes)
}

pub(super) fn validate_authority_anchor(
    lock: &File,
    authority_key: &[u8; 32],
) -> StoreResult<Option<JournalAuthorityIdentity>> {
    Ok(validate_anchor_bytes(&read_anchor(lock)?, authority_key)?.last_target)
}

#[derive(Clone, Copy, Debug)]
struct AuthorityIntent {
    anchor_offset: u64,
    anchor_prefix_sha256: [u8; 32],
    frame: AuthorityFrame,
}

impl AuthorityIntent {
    fn encode(&self, authority_key: &[u8; 32]) -> StoreResult<[u8; AUTHORITY_INTENT_BYTES]> {
        let mut bytes = [0; AUTHORITY_INTENT_BYTES];
        bytes[0..8].copy_from_slice(AUTHORITY_INTENT_MAGIC);
        bytes[8..10].copy_from_slice(&AUTHORITY_INTENT_VERSION.to_be_bytes());
        bytes[10..12].copy_from_slice(&(AUTHORITY_INTENT_BYTES as u16).to_be_bytes());
        bytes[12..20].copy_from_slice(&self.anchor_offset.to_be_bytes());
        bytes[20..52].copy_from_slice(&self.anchor_prefix_sha256);
        bytes[52..260].copy_from_slice(&self.frame.encode());
        let mac = hmac(authority_key, &bytes[..AUTHORITY_INTENT_MAC_OFFSET])?;
        bytes[AUTHORITY_INTENT_MAC_OFFSET..].copy_from_slice(&mac);
        Ok(bytes)
    }

    fn decode(bytes: &[u8], authority_key: &[u8; 32]) -> StoreResult<Self> {
        if bytes.len() != AUTHORITY_INTENT_BYTES
            || &bytes[0..8] != AUTHORITY_INTENT_MAGIC
            || read_u16(&bytes[8..10]) != AUTHORITY_INTENT_VERSION
            || read_u16(&bytes[10..12]) as usize != AUTHORITY_INTENT_BYTES
        {
            return Err(authority_invalid(
                "authority intent has invalid fixed framing",
            ));
        }
        let expected_mac = hmac(authority_key, &bytes[..AUTHORITY_INTENT_MAC_OFFSET])?;
        if !bool::from(expected_mac.ct_eq(&bytes[AUTHORITY_INTENT_MAC_OFFSET..])) {
            return Err(authority_invalid("authority intent HMAC does not verify"));
        }
        let intent = Self {
            anchor_offset: read_u64(&bytes[12..20]),
            anchor_prefix_sha256: bytes[20..52]
                .try_into()
                .expect("fixed intent prefix digest slice"),
            frame: AuthorityFrame::decode(&bytes[52..260], authority_key)?,
        };
        if intent.anchor_offset < AUTHORITY_COMMITMENT_BYTES
            || intent.anchor_offset > MAX_AUTHORITY_ANCHOR_BYTES - AUTHORITY_FRAME_BYTES as u64
            || !(intent.anchor_offset - AUTHORITY_COMMITMENT_BYTES)
                .is_multiple_of(AUTHORITY_FRAME_BYTES as u64)
            || intent.frame.sequence
                != (intent.anchor_offset - AUTHORITY_COMMITMENT_BYTES)
                    / AUTHORITY_FRAME_BYTES as u64
                    + 1
        {
            return Err(authority_invalid("authority intent offset is invalid"));
        }
        Ok(intent)
    }
}

fn authority_invalid(detail: impl std::fmt::Display) -> super::PluginPermissionStoreError {
    super::PluginPermissionStoreError::new("plugin_permission_authority_invalid", detail)
}

fn authority_interrupted(detail: impl std::fmt::Display) -> super::PluginPermissionStoreError {
    super::PluginPermissionStoreError::new("plugin_permission_authority_interrupted", detail)
}

fn authority_io(action: &str, error: std::io::Error) -> super::PluginPermissionStoreError {
    super::PluginPermissionStoreError::new(
        "plugin_permission_store_io",
        format!("{action}: {error}"),
    )
}

fn optional_owned_bytes(path: &Path, maximum_bytes: u64) -> StoreResult<Option<Vec<u8>>> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => {
            let mut file = open_owned_file(path, false)?;
            let length = file
                .metadata()
                .map_err(|error| io_error("inspect permission authority file", path, error))?
                .len();
            if length > maximum_bytes {
                return Err(authority_invalid(format!(
                    "{} exceeds its byte bound",
                    path.display()
                )));
            }
            let mut bytes = Vec::with_capacity(usize::try_from(length).unwrap_or(0));
            Read::by_ref(&mut file)
                .take(maximum_bytes + 1)
                .read_to_end(&mut bytes)
                .map_err(|error| io_error("read permission authority file", path, error))?;
            if bytes.len() as u64 > maximum_bytes {
                return Err(authority_invalid(format!(
                    "{} exceeds its byte bound",
                    path.display()
                )));
            }
            Ok(Some(bytes))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(io_error("inspect permission authority file", path, error)),
    }
}

fn read_intent(directory: &Path, authority_key: &[u8; 32]) -> StoreResult<Option<AuthorityIntent>> {
    let path = directory.join(COMPACTION_INTENT_FILE);
    let Some(bytes) = optional_owned_bytes(&path, AUTHORITY_INTENT_BYTES as u64)? else {
        return Ok(None);
    };
    Ok(Some(AuthorityIntent::decode(&bytes, authority_key)?))
}

fn remove_owned_file(path: &Path, action: &str) -> StoreResult<()> {
    open_owned_file(path, false)?;
    std::fs::remove_file(path).map_err(|error| io_error(action, path, error))
}

fn cleanup_orphan_targets(directory: &Path, maximum_journal_bytes: u64) -> StoreResult<()> {
    let mut removed = false;
    for (name, bound, action) in [
        (
            COMPACTION_TARGET_FILE,
            maximum_journal_bytes,
            "remove orphaned permission authority target",
        ),
        (
            COMPACTION_INTENT_TARGET_FILE,
            AUTHORITY_INTENT_BYTES as u64,
            "remove orphaned permission authority intent target",
        ),
    ] {
        let target = directory.join(name);
        if optional_owned_bytes(&target, bound)?.is_some() {
            remove_owned_file(&target, action)?;
            removed = true;
        }
    }
    if removed {
        sync_directory(directory)?;
    }
    Ok(())
}

pub(super) fn recovery_required(directory: &Path) -> StoreResult<bool> {
    validate_owned_directory(directory)?;
    for name in [
        COMPACTION_INTENT_FILE,
        COMPACTION_INTENT_TARGET_FILE,
        COMPACTION_TARGET_FILE,
    ] {
        match std::fs::symlink_metadata(directory.join(name)) {
            Ok(_) => return Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(io_error(
                    "inspect permission authority recovery artifact",
                    &directory.join(name),
                    error,
                ));
            }
        }
    }
    Ok(false)
}

fn append_or_repair_anchor(
    lock: &File,
    intent: AuthorityIntent,
    authority_key: &[u8; 32],
) -> StoreResult<()> {
    let bytes = read_anchor(lock)?;
    let offset = usize::try_from(intent.anchor_offset)
        .map_err(|_| authority_invalid("authority intent offset overflow"))?;
    if bytes.len() < offset
        || !bool::from(
            intent
                .anchor_prefix_sha256
                .ct_eq(Sha256::digest(&bytes[..offset]).as_slice()),
        )
    {
        return Err(authority_interrupted(
            "authority anchor does not match the intent's exact durable prefix",
        ));
    }
    let prefix = validate_anchor_bytes(&bytes[..offset], authority_key)?;
    if prefix.frame_count + 1 != intent.frame.sequence
        || !bool::from(prefix.last_mac.ct_eq(&intent.frame.previous_mac))
        || prefix
            .last_target
            .is_some_and(|identity| identity != intent.frame.source)
    {
        return Err(authority_interrupted(
            "authority intent frame does not continue its exact durable prefix",
        ));
    }
    let frame = intent.frame.encode();
    let tail = &bytes[offset..];
    if tail.len() > frame.len() || !bool::from(tail.ct_eq(&frame[..tail.len()])) {
        return Err(authority_interrupted(
            "authority anchor tail is not the intent's exact target frame",
        ));
    }
    if tail.len() == frame.len() {
        return Ok(());
    }
    let mut writer = lock;
    if !tail.is_empty() {
        writer
            .set_len(intent.anchor_offset)
            .map_err(|error| authority_io("truncate partial authority frame", error))?;
    }
    writer
        .seek(SeekFrom::Start(intent.anchor_offset))
        .and_then(|_| writer.write_all(&frame))
        .map_err(|error| authority_io("append permission authority frame", error))?;
    writer
        .sync_all()
        .map_err(|error| authority_io("sync permission authority anchor", error))?;
    Ok(())
}

pub(super) fn recover_compaction(
    access: &ExclusiveJournalAccess<'_>,
    journal_file: &str,
    maximum_journal_bytes: u64,
    authority_key: &[u8; 32],
) -> StoreResult<()> {
    let directory = access.directory();
    validate_owned_directory(directory)?;
    let Some(intent) = read_intent(directory, authority_key)? else {
        validate_authority_anchor(access._lock, authority_key)?;
        return cleanup_orphan_targets(directory, maximum_journal_bytes);
    };
    let canonical_path = directory.join(journal_file);
    let target_path = directory.join(COMPACTION_TARGET_FILE);
    let canonical = optional_owned_bytes(&canonical_path, maximum_journal_bytes)?;
    let target = optional_owned_bytes(&target_path, maximum_journal_bytes)?;
    let canonical_is_source = canonical
        .as_deref()
        .is_some_and(|bytes| intent.frame.source.matches(bytes));
    let canonical_is_target = canonical
        .as_deref()
        .is_some_and(|bytes| intent.frame.target.matches(bytes));
    let staged_is_target = target
        .as_deref()
        .is_some_and(|bytes| intent.frame.target.matches(bytes));
    let publication_pending = canonical_is_source && staged_is_target;
    let publication_complete = canonical_is_target && target.is_none();
    if !publication_pending && !publication_complete {
        return Err(authority_interrupted(
            "authority files match neither the recorded source nor target identity",
        ));
    }

    append_or_repair_anchor(access._lock, intent, authority_key)?;

    if publication_pending {
        std::fs::rename(&target_path, &canonical_path).map_err(|error| {
            io_error(
                "resume permission authority publication",
                &canonical_path,
                error,
            )
        })?;
        sync_directory(directory)?;
    }

    let anchored = validate_authority_anchor(access._lock, authority_key)?;
    let canonical = optional_owned_bytes(&canonical_path, maximum_journal_bytes)?
        .ok_or_else(|| authority_interrupted("authoritative permission journal disappeared"))?;
    if anchored != Some(intent.frame.target) || !intent.frame.target.matches(&canonical) {
        return Err(authority_interrupted(
            "recovered journal does not match the committed authority identity",
        ));
    }
    let intent_path = directory.join(COMPACTION_INTENT_FILE);
    remove_owned_file(&intent_path, "complete permission authority intent")?;
    sync_directory(directory)
}

pub(super) fn publish_authoritative_replacement(
    access: &ExclusiveJournalAccess<'_>,
    journal_file: &str,
    replacement: JournalAuthorityReplacement<'_>,
    maximum_journal_bytes: u64,
    authority_key: &[u8; 32],
) -> StoreResult<()> {
    let source = replacement.source.bytes;
    let target = replacement.target.bytes;
    let source_state = replacement.source.state;
    let target_state = replacement.target.state;
    let mutation_kind = replacement.mutation_kind;
    #[cfg(test)]
    let _active_mutation_kind = ActiveMutationKindGuard::enter(mutation_kind);
    let directory = access.directory();
    validate_owned_directory(directory)?;
    if source.len() as u64 > maximum_journal_bytes || target.len() as u64 > maximum_journal_bytes {
        return Err(authority_invalid(
            "permission authority source or target exceeds the journal bound",
        ));
    }
    if read_intent(directory, authority_key)?.is_some() {
        return Err(authority_interrupted(
            "a prior permission authority intent requires recovery",
        ));
    }
    cleanup_orphan_targets(directory, maximum_journal_bytes)?;

    let canonical_path = directory.join(journal_file);
    let current =
        optional_owned_bytes(&canonical_path, maximum_journal_bytes)?.ok_or_else(|| {
            authority_interrupted("permission journal disappeared before replacement")
        })?;
    if current != source {
        return Err(authority_interrupted(
            "permission journal changed before authority preparation",
        ));
    }

    let anchor = read_anchor(access._lock)?;
    let tail = validate_anchor_bytes(&anchor, authority_key)?;
    let source_identity = JournalAuthorityIdentity::from_bytes(source, source_state)?;
    let target_identity = JournalAuthorityIdentity::from_bytes(target, target_state)?;
    if tail
        .last_target
        .is_some_and(|identity| identity != source_identity)
    {
        return Err(authority_interrupted(
            "permission journal does not match the authority anchor's current identity",
        ));
    }
    let frame = AuthorityFrame::new(
        tail.frame_count + 1,
        tail.last_mac,
        source_identity,
        target_identity,
        mutation_kind,
        authority_key,
    )?;
    let intent = AuthorityIntent {
        anchor_offset: anchor.len() as u64,
        anchor_prefix_sha256: Sha256::digest(&anchor).into(),
        frame,
    };

    let target_path = directory.join(COMPACTION_TARGET_FILE);
    let intent_path = directory.join(COMPACTION_INTENT_FILE);
    let intent_target_path = directory.join(COMPACTION_INTENT_TARGET_FILE);
    let mut target_file = create_owned_file(&target_path)?;
    let before_intent = (|| -> StoreResult<()> {
        inject_compaction_fault(CompactionFaultStageForBuild::TargetWrite)?;
        target_file
            .write_all(target)
            .map_err(|error| io_error("write permission authority target", &target_path, error))?;
        inject_compaction_fault(CompactionFaultStageForBuild::TargetSync)?;
        target_file
            .sync_all()
            .map_err(|error| io_error("sync permission authority target", &target_path, error))?;
        inject_compaction_fault(CompactionFaultStageForBuild::TargetDirectorySync)?;
        sync_directory(directory)?;

        let encoded = intent.encode(authority_key)?;
        let mut intent_file = create_owned_file(&intent_target_path)?;
        inject_compaction_fault(CompactionFaultStageForBuild::IntentWrite)?;
        intent_file.write_all(&encoded).map_err(|error| {
            io_error(
                "write permission authority intent target",
                &intent_target_path,
                error,
            )
        })?;
        inject_compaction_fault(CompactionFaultStageForBuild::IntentSync)?;
        intent_file.sync_all().map_err(|error| {
            io_error(
                "sync permission authority intent target",
                &intent_target_path,
                error,
            )
        })?;
        inject_compaction_fault(CompactionFaultStageForBuild::IntentTargetDirectorySync)?;
        sync_directory(directory)?;
        inject_compaction_fault(CompactionFaultStageForBuild::IntentPublishRename)?;
        std::fs::rename(&intent_target_path, &intent_path).map_err(|error| {
            io_error("publish permission authority intent", &intent_path, error)
        })?;
        inject_compaction_fault(CompactionFaultStageForBuild::IntentPublishDirectorySync)?;
        sync_directory(directory)
    })();
    if let Err(error) = before_intent {
        if matches!(
            std::fs::symlink_metadata(&intent_path),
            Err(observation) if observation.kind() == std::io::ErrorKind::NotFound
        ) {
            let _cleanup_result = cleanup_orphan_targets(directory, maximum_journal_bytes);
        }
        return Err(error);
    }

    inject_compaction_fault(CompactionFaultStageForBuild::AnchorWrite)?;
    {
        let mut lock = access._lock;
        lock.seek(SeekFrom::Start(intent.anchor_offset))
            .and_then(|_| lock.write_all(&intent.frame.encode()))
            .map_err(|error| authority_io("append permission authority frame", error))?;
    }
    inject_compaction_fault(CompactionFaultStageForBuild::AnchorSync)?;
    access
        ._lock
        .sync_all()
        .map_err(|error| authority_io("sync permission authority anchor", error))?;

    inject_compaction_fault(CompactionFaultStageForBuild::SourceRevalidate)?;
    let canonical =
        optional_owned_bytes(&canonical_path, maximum_journal_bytes)?.ok_or_else(|| {
            authority_interrupted("permission journal disappeared before publication")
        })?;
    if !intent.frame.source.matches(&canonical) {
        return Err(authority_interrupted(
            "permission journal changed before authority publication",
        ));
    }

    inject_compaction_fault(CompactionFaultStageForBuild::PublishRename)?;
    std::fs::rename(&target_path, &canonical_path).map_err(|error| {
        io_error(
            "publish authoritative permission journal",
            &canonical_path,
            error,
        )
    })?;
    inject_compaction_fault(CompactionFaultStageForBuild::PublishDirectorySync)?;
    sync_directory(directory)?;
    let anchored = validate_authority_anchor(access._lock, authority_key)?;
    let canonical = optional_owned_bytes(&canonical_path, maximum_journal_bytes)?
        .ok_or_else(|| authority_interrupted("authoritative permission journal disappeared"))?;
    if anchored != Some(intent.frame.target) || !intent.frame.target.matches(&canonical) {
        return Err(authority_interrupted(
            "published journal does not match the committed authority identity",
        ));
    }
    inject_compaction_fault(CompactionFaultStageForBuild::IntentCleanup)?;
    remove_owned_file(&intent_path, "complete permission authority intent")?;
    inject_compaction_fault(CompactionFaultStageForBuild::IntentCleanupDirectorySync)?;
    sync_directory(directory)
}

pub(super) fn publish_compaction(
    access: &ExclusiveJournalAccess<'_>,
    journal_file: &str,
    source: JournalAuthoritySnapshot<'_>,
    target: JournalAuthoritySnapshot<'_>,
    maximum_journal_bytes: u64,
    authority_key: &[u8; 32],
) -> StoreResult<()> {
    publish_authoritative_replacement(
        access,
        journal_file,
        JournalAuthorityReplacement {
            source,
            target,
            mutation_kind: JournalMutationKind::Compaction,
        },
        maximum_journal_bytes,
        authority_key,
    )
}

#[cfg(test)]
pub(super) fn compaction_paths(directory: &Path) -> (PathBuf, PathBuf) {
    (
        directory.join(COMPACTION_INTENT_FILE),
        directory.join(COMPACTION_TARGET_FILE),
    )
}

#[cfg(test)]
mod authority_tests {
    use super::*;

    fn identity(byte: u8, generation: u64, count: u64) -> JournalAuthorityIdentity {
        JournalAuthorityIdentity {
            sha256: [byte; 32],
            len: byte as u64 + 1,
            state: JournalAuthorityState {
                format_generation: generation,
                logical_count: count,
            },
        }
    }

    #[test]
    fn fixed_frame_round_trip_authenticates_all_fields() {
        let key = [7; 32];
        let source = identity(1, 0, 4);
        let target = identity(2, 0, 5);
        let frame = AuthorityFrame::new(
            1,
            [0; 32],
            source,
            target,
            JournalMutationKind::EventAppend,
            &key,
        )
        .unwrap();
        let encoded = frame.encode();
        assert_eq!(encoded.len(), AUTHORITY_FRAME_BYTES);
        assert_eq!(AuthorityFrame::decode(&encoded, &key).unwrap(), frame);

        let mut tampered = encoded;
        tampered[100] ^= 1;
        assert_eq!(
            AuthorityFrame::decode(&tampered, &key).unwrap_err().code(),
            "plugin_permission_authority_invalid"
        );
        let mut nonzero_reserved = encoded;
        nonzero_reserved[13] = 1;
        assert_eq!(
            AuthorityFrame::decode(&nonzero_reserved, &key)
                .unwrap_err()
                .code(),
            "plugin_permission_authority_invalid"
        );
    }

    #[test]
    fn anchor_returns_last_target_and_rejects_an_unintended_partial_tail() {
        let key = [11; 32];
        let source = identity(3, 0, 0);
        let target = identity(4, 0, 1);
        let frame = AuthorityFrame::new(
            1,
            [0; 32],
            source,
            target,
            JournalMutationKind::EventAppend,
            &key,
        )
        .unwrap();
        let mut anchor = Sha256::digest(key).to_vec();
        assert_eq!(
            validate_anchor_bytes(&anchor, &key).unwrap().last_target,
            None
        );
        anchor.extend_from_slice(&frame.encode());
        assert_eq!(
            validate_anchor_bytes(&anchor, &key).unwrap().last_target,
            Some(target)
        );
        assert!(anchor.len() > AUTHORITY_COMMITMENT_BYTES as usize);

        anchor.pop();
        assert_eq!(
            validate_anchor_bytes(&anchor, &key).unwrap_err().code(),
            "plugin_permission_authority_invalid"
        );
    }

    #[test]
    fn intent_is_fixed_authenticated_and_bound_to_its_exact_prefix() {
        let key = [13; 32];
        let prefix = Sha256::digest(key).to_vec();
        let frame = AuthorityFrame::new(
            1,
            [0; 32],
            identity(5, 0, 9),
            identity(6, 1, 9),
            JournalMutationKind::Compaction,
            &key,
        )
        .unwrap();
        let intent = AuthorityIntent {
            anchor_offset: prefix.len() as u64,
            anchor_prefix_sha256: Sha256::digest(&prefix).into(),
            frame,
        };
        let encoded = intent.encode(&key).unwrap();
        assert_eq!(encoded.len(), AUTHORITY_INTENT_BYTES);
        let decoded = AuthorityIntent::decode(&encoded, &key).unwrap();
        assert_eq!(decoded.anchor_offset, intent.anchor_offset);
        assert_eq!(decoded.anchor_prefix_sha256, intent.anchor_prefix_sha256);
        assert_eq!(decoded.frame, intent.frame);

        let mut tampered = encoded;
        tampered[20] ^= 1;
        assert_eq!(
            AuthorityIntent::decode(&tampered, &key).unwrap_err().code(),
            "plugin_permission_authority_invalid"
        );
    }

    #[test]
    fn transition_bounds_are_strict() {
        let key = [17; 32];
        let source = identity(7, 0, 1);
        let target = identity(8, 0, 2);
        assert_eq!(
            AuthorityFrame::new(
                MAX_AUTHORITY_FRAMES + 1,
                [0; 32],
                source,
                target,
                JournalMutationKind::EventAppend,
                &key,
            )
            .unwrap_err()
            .code(),
            "plugin_permission_authority_invalid"
        );
        assert_eq!(
            AuthorityFrame::new(
                1,
                [0; 32],
                source,
                source,
                JournalMutationKind::BaselineMigration,
                &key,
            )
            .unwrap()
            .target,
            source
        );
    }
}
