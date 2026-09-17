use crate::exit::ExitTombstone;
use crate::{ProcessProof, RuntimeContext, VersionRange};
use serde::{Deserialize, Serialize};
use std::fmt;

pub const MANIFEST_SCHEMA_V1: u16 = 1;

/// The trust class a hosted session belongs to. This is the structural fence
/// that keeps orchestration-managed sessions and local standalone (tmux-like)
/// sessions from ever satisfying each other's attach-authorization arm.
///
/// `Managed` is the serde default so every existing on-disk manifest and every
/// managed Host deserializes and constructs as `Managed`, and (because
/// `ManifestCommon` skips serializing the default) a managed manifest is
/// byte-identical to the pre-standalone shape. A `Standalone` session carries no
/// WorkNode, claim, branch, or daemon authority; its only trust boundary is the
/// same-user/same-host Unix-socket peer credential, and its class is read from
/// in-memory Host state at attach time, never from the (same-user-writable) disk
/// manifest, so an on-disk relabel cannot flip a live session's class.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionClass {
    #[default]
    Managed,
    Standalone,
}

/// A Host-owned session lifetime contract.
///
/// Absence from [`ManifestCommon::retirement_policy`] is the durable
/// compatibility default: the session is retained until an explicit stop.
/// Opt-in policies are versioned on the wire and carry their complete timing
/// contract so a replacement Host does not silently reinterpret them.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SessionRetirementPolicy {
    AfterGracefulLastClientDepartureV1 {
        #[serde(with = "crate::json_u64")]
        grace_period_ms: u64,
    },
}

impl SessionRetirementPolicy {
    pub const MIN_GRACE_PERIOD_MS: u64 = 1_000;
    pub const MAX_GRACE_PERIOD_MS: u64 = 300_000;

    #[must_use]
    pub fn grace_period_ms(self) -> u64 {
        match self {
            Self::AfterGracefulLastClientDepartureV1 { grace_period_ms } => grace_period_ms,
        }
    }

    #[must_use]
    pub fn is_valid(self) -> bool {
        (Self::MIN_GRACE_PERIOD_MS..=Self::MAX_GRACE_PERIOD_MS).contains(&self.grace_period_ms())
    }
}

impl SessionClass {
    #[must_use]
    pub fn is_managed(&self) -> bool {
        matches!(self, Self::Managed)
    }

    #[must_use]
    pub fn is_standalone(&self) -> bool {
        matches!(self, Self::Standalone)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct HostLifetimeIdentity {
    pub workspace_id: String,
    pub session_id: String,
    pub runner_principal: String,
    pub runner_instance: String,
    pub channel_epoch: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ClaimLinkage {
    pub claim_id: Option<String>,
    pub kickoff_action_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ManifestCommon {
    pub schema_version: u16,
    pub host_build_version: String,
    pub supported_protocol: VersionRange,
    pub capabilities: Vec<String>,
    pub lifetime: HostLifetimeIdentity,
    pub host_instance_id: String,
    pub provider_id: String,
    pub runtime_context: RuntimeContext,
    pub claim_linkage: ClaimLinkage,
    pub host_process: ProcessProof,
    pub created_unix_ms: u64,
    // Why: these fields default to Managed/None and skip serialization in that
    // case, so every persistent managed manifest stays byte-identical to the
    // pre-standalone shape and legacy manifests deserialize as retained
    // Managed sessions. There is no Default derive on ManifestCommon, so each
    // construction site must set all three explicitly (golden serialization
    // tests guard against drift).
    #[serde(default, skip_serializing_if = "SessionClass::is_managed")]
    pub session_class: SessionClass,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_name: Option<String>,
    /// `None` is intentionally distinct from an opt-in policy. Existing
    /// manifests therefore stay retained and byte-compatible.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retirement_policy: Option<SessionRetirementPolicy>,
    /// What this session was launched to run, as a bare program name.
    ///
    /// The *name only* — never the arguments. A command line is where secrets
    /// live: `ssh -o ProxyCommand=…`, a token passed as a flag, a password in
    /// argv. This file is read by anything that can read the discovery root,
    /// and a listing is shown on a phone. The program name answers the question
    /// a session list actually asks ("is this an ssh session or a shell?")
    /// without carrying any of that.
    ///
    /// It describes the *launch*, not the present: a shell that later ran `ssh`
    /// still reads `zsh`. Naming it `launch_program` rather than `program` is
    /// what keeps a reader from believing otherwise.
    ///
    /// `None` for manifests written before this field existed, which is why it
    /// is an `Option` that skips serialization — those files stay byte-identical
    /// and keep deserializing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_program: Option<String>,
}

/// The longest program name a manifest will carry.
///
/// Bounded because this is attacker-influenceable in the ordinary way — a
/// session can be launched with any path — and every manifest field has to
/// stay small enough that a listing cannot be made expensive by one row.
pub const LAUNCH_PROGRAM_MAX_BYTES: usize = 64;

/// The bare program name for [`ManifestCommon::launch_program`], or `None`.
///
/// Refuses rather than truncates. A truncated name is a name that reads as a
/// different program — `ssh-something-long` becoming `ssh` is exactly the
/// wrong direction for a field a person uses to tell sessions apart.
///
/// Refuses anything holding `=`, and that guard is the one that matters.
/// Callers resolve through launchers to find the real program, and that
/// resolution is built for an *identity check*, where a wrong answer yields a
/// mismatch and the session is preserved. Here the same wrong answer is
/// published — into this file, the gateway catalog, the desktop's hub catalog,
/// and onto a phone screen. `env -- API_TOKEN=abc node server.js` is valid
/// POSIX, and after `--` a resolver has no option syntax left to recognise the
/// assignment by, so it hands back `API_TOKEN=abc`. A name with `=` in it is
/// not a program name, and refusing at this boundary holds whichever caller
/// got here.
#[must_use]
pub fn launch_program_label(program: &std::path::Path) -> Option<String> {
    let name = program.file_name()?.to_str()?;
    if name.is_empty() || name.len() > LAUNCH_PROGRAM_MAX_BYTES || name.contains('=') {
        return None;
    }
    Some(name.to_string())
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct StartingManifest {
    pub common: ManifestCommon,
    pub starting_unix_ms: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalEndpointKind {
    UnixSocket,
    WindowsNamedPipe,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct LocalEndpoint {
    pub kind: LocalEndpointKind,
    pub address: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ReadyManifest {
    pub common: ManifestCommon,
    pub provider_process: ProcessProof,
    pub terminal_epoch: String,
    pub ready_output_seq: u64,
    pub endpoint: LocalEndpoint,
    pub capability_token: String,
    pub ready_unix_ms: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ExitedManifest {
    pub common: ManifestCommon,
    pub tombstone: Box<ExitTombstone>,
    pub endpoint: LocalEndpoint,
    pub capability_token: String,
    pub exited_unix_ms: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "lifecycle", content = "manifest", rename_all = "snake_case")]
pub enum DiscoveryManifest {
    Starting(StartingManifest),
    Ready(ReadyManifest),
    Exited(ExitedManifest),
}

impl DiscoveryManifest {
    #[must_use]
    pub fn common(&self) -> &ManifestCommon {
        match self {
            Self::Starting(manifest) => &manifest.common,
            Self::Ready(manifest) => &manifest.common,
            Self::Exited(manifest) => &manifest.common,
        }
    }

    #[must_use]
    pub fn generation(&self) -> ManifestGeneration {
        ManifestGeneration {
            host_instance_id: self.common().host_instance_id.clone(),
            host_process: self.common().host_process.clone(),
            terminal_epoch: match self {
                Self::Starting(_) => None,
                Self::Ready(manifest) => Some(manifest.terminal_epoch.clone()),
                Self::Exited(manifest) => Some(manifest.tombstone.fence.terminal_epoch.clone()),
            },
        }
    }

    pub fn validate(&self, limits: &ManifestLimits) -> Result<(), ManifestValidationError> {
        validate_common(self.common(), limits)?;
        match self {
            Self::Starting(manifest) => {
                if manifest.starting_unix_ms == 0 {
                    return Err(out_of_range("starting_unix_ms"));
                }
            }
            Self::Ready(manifest) => validate_ready(manifest, limits)?,
            Self::Exited(manifest) => validate_exited(manifest, limits)?,
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManifestGeneration {
    pub host_instance_id: String,
    pub host_process: ProcessProof,
    pub terminal_epoch: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManifestLimits {
    pub max_manifest_bytes: usize,
    pub max_identifier_bytes: usize,
    pub max_context_bytes: usize,
    pub max_endpoint_bytes: usize,
    pub max_capability_token_bytes: usize,
    pub max_capabilities: usize,
    pub max_capability_bytes: usize,
    pub max_session_lookup_entries: usize,
    /// Valid sessions admitted into one complete client catalog census.
    pub max_session_catalog_entries: usize,
    pub max_session_lookup_candidates: usize,
    pub max_session_census_scan_entries: usize,
    /// Raw directory entries inspected by retired-history lookup/admission.
    pub max_retired_manifest_scan_entries: usize,
    /// Owner-only non-temporary retired files admitted per logical session.
    pub max_retired_manifest_entries: usize,
    /// Aggregate bytes of retired files and crash temporaries admitted per
    /// logical session.
    pub max_retired_manifest_bytes: u64,
}

impl Default for ManifestLimits {
    fn default() -> Self {
        Self {
            max_manifest_bytes: 256 * 1024,
            max_identifier_bytes: 256,
            max_context_bytes: 512,
            max_endpoint_bytes: 1024,
            max_capability_token_bytes: 512,
            max_capabilities: 64,
            max_capability_bytes: 128,
            max_session_lookup_entries: 128,
            max_session_catalog_entries: 1_024,
            max_session_lookup_candidates: 32,
            max_session_census_scan_entries: 16_384,
            max_retired_manifest_scan_entries: 4_096,
            max_retired_manifest_entries: 128,
            max_retired_manifest_bytes: 64 * 1024 * 1024,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ManifestValidationError {
    Empty {
        field: &'static str,
    },
    TooLong {
        field: &'static str,
        actual: usize,
        maximum: usize,
    },
    TooMany {
        field: &'static str,
        actual: usize,
        maximum: usize,
    },
    OutOfRange {
        field: &'static str,
    },
    Inconsistent {
        field: &'static str,
    },
}

impl fmt::Display for ManifestValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty { field } => write!(formatter, "{field} must not be empty"),
            Self::TooLong {
                field,
                actual,
                maximum,
            } => write!(
                formatter,
                "{field} length {actual} exceeds maximum {maximum}"
            ),
            Self::TooMany {
                field,
                actual,
                maximum,
            } => write!(
                formatter,
                "{field} count {actual} exceeds maximum {maximum}"
            ),
            Self::OutOfRange { field } => write!(formatter, "{field} is out of range"),
            Self::Inconsistent { field } => write!(formatter, "{field} is inconsistent"),
        }
    }
}

impl std::error::Error for ManifestValidationError {}

fn validate_common(
    common: &ManifestCommon,
    limits: &ManifestLimits,
) -> Result<(), ManifestValidationError> {
    if common.schema_version != MANIFEST_SCHEMA_V1 {
        return Err(out_of_range("schema_version"));
    }
    if common.created_unix_ms == 0 || common.host_process.process_id == 0 {
        return Err(out_of_range("host_process_or_creation_time"));
    }
    if common.supported_protocol.minimum.major == 0
        || common.supported_protocol.minimum > common.supported_protocol.maximum
    {
        return Err(ManifestValidationError::Inconsistent {
            field: "supported_protocol",
        });
    }
    for (field, value) in [
        ("host_build_version", common.host_build_version.as_str()),
        ("workspace_id", common.lifetime.workspace_id.as_str()),
        ("session_id", common.lifetime.session_id.as_str()),
        (
            "runner_principal",
            common.lifetime.runner_principal.as_str(),
        ),
        ("runner_instance", common.lifetime.runner_instance.as_str()),
        ("host_instance_id", common.host_instance_id.as_str()),
        ("provider_id", common.provider_id.as_str()),
        (
            "host_start_marker",
            common.host_process.start_marker.as_str(),
        ),
    ] {
        bounded(field, value, limits.max_identifier_bytes)?;
    }
    // Bounded on the way *in*, not only where this crate writes it. A manifest
    // is a file on disk that any build may have written, and validation is the
    // only place that reads one this build did not produce.
    optional_bounded(
        "launch_program",
        common.launch_program.as_deref(),
        LAUNCH_PROGRAM_MAX_BYTES,
    )?;
    optional_bounded(
        "claim_id",
        common.claim_linkage.claim_id.as_deref(),
        limits.max_identifier_bytes,
    )?;
    optional_bounded(
        "kickoff_action_id",
        common.claim_linkage.kickoff_action_id.as_deref(),
        limits.max_identifier_bytes,
    )?;
    for (field, value) in [
        (
            "runtime_host",
            common.runtime_context.runtime_host.as_deref(),
        ),
        (
            "worktree_alias",
            common.runtime_context.worktree_alias.as_deref(),
        ),
        ("branch", common.runtime_context.branch.as_deref()),
    ] {
        optional_bounded(field, value, limits.max_context_bytes)?;
    }
    if common.capabilities.len() > limits.max_capabilities {
        return Err(ManifestValidationError::TooMany {
            field: "capabilities",
            actual: common.capabilities.len(),
            maximum: limits.max_capabilities,
        });
    }
    for capability in &common.capabilities {
        bounded("capability", capability, limits.max_capability_bytes)?;
    }
    optional_bounded(
        "session_name",
        common.session_name.as_deref(),
        limits.max_identifier_bytes,
    )?;
    // Why: a standalone session is addressed by its human name at the CLI edge,
    // so a standalone manifest without one is unusable and must be rejected as
    // inconsistent rather than silently unnamed. Managed sessions never carry a
    // name and are unaffected.
    if common.session_class.is_standalone() && common.session_name.is_none() {
        return Err(ManifestValidationError::Inconsistent {
            field: "session_name",
        });
    }
    if common
        .retirement_policy
        .is_some_and(|policy| !policy.is_valid())
        || (common.session_class.is_managed() && common.retirement_policy.is_some())
    {
        return Err(ManifestValidationError::Inconsistent {
            field: "retirement_policy",
        });
    }
    Ok(())
}

fn validate_ready(
    manifest: &ReadyManifest,
    limits: &ManifestLimits,
) -> Result<(), ManifestValidationError> {
    // Provider readiness is a process/PTY fact, not proof that the provider
    // has emitted terminal activity. Both managed and standalone Hosts may
    // become attachable at output sequence zero.
    if manifest.provider_process.process_id == 0 || manifest.ready_unix_ms == 0 {
        return Err(out_of_range("ready_process_time_or_output_seq"));
    }
    bounded(
        "provider_start_marker",
        &manifest.provider_process.start_marker,
        limits.max_identifier_bytes,
    )?;
    bounded(
        "terminal_epoch",
        &manifest.terminal_epoch,
        limits.max_identifier_bytes,
    )?;
    bounded(
        "endpoint.address",
        &manifest.endpoint.address,
        limits.max_endpoint_bytes,
    )?;
    bounded(
        "capability_token",
        &manifest.capability_token,
        limits.max_capability_token_bytes,
    )
}

fn validate_exited(
    manifest: &ExitedManifest,
    limits: &ManifestLimits,
) -> Result<(), ManifestValidationError> {
    if manifest.exited_unix_ms == 0
        || manifest.tombstone.created_unix_ms == 0
        || manifest.tombstone.provider_process.process_id == 0
    {
        return Err(out_of_range("exited_process_or_time"));
    }
    let lifetime = &manifest.common.lifetime;
    let fence = &manifest.tombstone.fence;
    if lifetime.workspace_id != fence.workspace_id
        || lifetime.session_id != fence.session_id
        || lifetime.runner_principal != fence.runner_principal
        || lifetime.runner_instance != fence.runner_instance
        || lifetime.channel_epoch != fence.channel_epoch
        || manifest.common.host_instance_id != fence.host_instance_id
    {
        return Err(ManifestValidationError::Inconsistent {
            field: "exit_tombstone_fence",
        });
    }
    for (field, value, maximum) in [
        (
            "terminal_epoch",
            fence.terminal_epoch.as_str(),
            limits.max_identifier_bytes,
        ),
        (
            "provider_start_marker",
            manifest.tombstone.provider_process.start_marker.as_str(),
            limits.max_identifier_bytes,
        ),
        (
            "exit_reason",
            manifest.tombstone.exit.reason.as_str(),
            limits.max_context_bytes,
        ),
        (
            "endpoint.address",
            manifest.endpoint.address.as_str(),
            limits.max_endpoint_bytes,
        ),
        (
            "capability_token",
            manifest.capability_token.as_str(),
            limits.max_capability_token_bytes,
        ),
    ] {
        bounded(field, value, maximum)?;
    }
    optional_bounded(
        "exit_platform_status",
        manifest.tombstone.exit.platform_status.as_deref(),
        limits.max_context_bytes,
    )?;
    let Some(failure) = &manifest.tombstone.failure else {
        return Ok(());
    };
    if failure.session_id != fence.session_id
        || failure.workspace_id != fence.workspace_id
        || failure.terminal_epoch != fence.terminal_epoch
        || failure.exit_kind != manifest.tombstone.exit_kind
        || failure.exit_code != manifest.tombstone.exit.exit_code
        || failure.occurred_unix_ms != manifest.tombstone.created_unix_ms
    {
        return Err(ManifestValidationError::Inconsistent {
            field: "session_failure_capsule",
        });
    }
    for (field, value, maximum) in [
        (
            "failure.correlation_id",
            failure.correlation_id.as_str(),
            limits.max_identifier_bytes,
        ),
        (
            "failure.session_id",
            failure.session_id.as_str(),
            limits.max_identifier_bytes,
        ),
        (
            "failure.workspace_id",
            failure.workspace_id.as_str(),
            limits.max_identifier_bytes,
        ),
        (
            "failure.terminal_epoch",
            failure.terminal_epoch.as_str(),
            limits.max_identifier_bytes,
        ),
        (
            "failure.code",
            failure.code.as_str(),
            limits.max_capability_bytes,
        ),
        (
            "failure.summary",
            failure.summary.as_str(),
            limits.max_context_bytes,
        ),
    ] {
        bounded(field, value, maximum)?;
    }
    let valid_code = failure.code.len() >= 3
        && failure
            .code
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
        && failure
            .code
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_lowercase);
    if !valid_code {
        return Err(ManifestValidationError::Inconsistent {
            field: "failure.code",
        });
    }
    Ok(())
}

fn bounded(
    field: &'static str,
    value: &str,
    maximum: usize,
) -> Result<(), ManifestValidationError> {
    if value.is_empty() {
        return Err(ManifestValidationError::Empty { field });
    }
    if value.len() > maximum {
        return Err(ManifestValidationError::TooLong {
            field,
            actual: value.len(),
            maximum,
        });
    }
    Ok(())
}

fn optional_bounded(
    field: &'static str,
    value: Option<&str>,
    maximum: usize,
) -> Result<(), ManifestValidationError> {
    value.map_or(Ok(()), |value| bounded(field, value, maximum))
}

fn out_of_range(field: &'static str) -> ManifestValidationError {
    ManifestValidationError::OutOfRange { field }
}

#[cfg(test)]
mod session_class_tests {

    /// A name carrying `=` is an environment assignment, not a program.
    ///
    /// The failure this pins: `env -- API_TOKEN=abc node server.js` is valid
    /// POSIX, and after `--` there is no option syntax left for a resolver to
    /// recognise the assignment by — it returns `API_TOKEN=abc` as the program.
    /// That value would be written into the manifest, served in the gateway
    /// catalog and the desktop's hub catalog, and drawn on a phone. Storing a
    /// name rather than a command line is only worth anything if the name
    /// cannot become an argument.
    #[test]
    fn an_environment_assignment_is_not_a_program_name() {
        assert_eq!(
            launch_program_label(std::path::Path::new("API_TOKEN=abc123")),
            None
        );
        assert_eq!(
            launch_program_label(std::path::Path::new("/usr/bin/ssh")),
            Some("ssh".to_string())
        );
    }
    use super::*;
    use crate::{ProcessProof, ProtocolVersion, RuntimeContext, VersionRange};

    fn managed_common() -> ManifestCommon {
        ManifestCommon {
            launch_program: None,
            schema_version: MANIFEST_SCHEMA_V1,
            host_build_version: "build".into(),
            supported_protocol: VersionRange {
                minimum: ProtocolVersion { major: 1, minor: 0 },
                maximum: ProtocolVersion { major: 1, minor: 1 },
            },
            capabilities: vec!["screen_snapshot".into()],
            lifetime: HostLifetimeIdentity {
                workspace_id: "workspace".into(),
                session_id: "session".into(),
                runner_principal: "principal".into(),
                runner_instance: "runner-1".into(),
                channel_epoch: 1,
            },
            host_instance_id: "host-1".into(),
            provider_id: "codex".into(),
            runtime_context: RuntimeContext::default(),
            claim_linkage: ClaimLinkage {
                claim_id: None,
                kickoff_action_id: None,
            },
            host_process: ProcessProof {
                process_id: 100,
                start_marker: "start".into(),
            },
            created_unix_ms: 1,
            session_class: SessionClass::Managed,
            session_name: None,
            retirement_policy: None,
        }
    }

    #[test]
    fn managed_common_omits_class_and_name_so_json_stays_byte_identical() {
        // Why: this is the byte-identical guard. A managed manifest must serialize
        // without the session_class or session_name keys so that adding the
        // standalone class never changes a single managed on-disk byte and never
        // trips fingerprint or golden-manifest comparisons elsewhere.
        let json = serde_json::to_string(&managed_common()).unwrap();
        assert!(
            !json.contains("session_class"),
            "managed manifest must omit session_class: {json}"
        );
        assert!(
            !json.contains("session_name"),
            "managed manifest must omit session_name: {json}"
        );
        assert!(
            !json.contains("retirement_policy"),
            "managed manifest must omit retirement_policy: {json}"
        );
    }

    #[test]
    fn legacy_manifest_without_class_deserializes_as_managed() {
        // Why: manifests written before this change carry neither key; serde
        // default must read them back as Managed so no running host is
        // misclassified after an upgrade.
        let json = serde_json::to_string(&managed_common()).unwrap();
        let parsed: ManifestCommon = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.session_class, SessionClass::Managed);
        assert_eq!(parsed, managed_common());
    }

    #[test]
    fn standalone_common_roundtrips_with_class_and_name() {
        let mut common = managed_common();
        common.session_class = SessionClass::Standalone;
        common.session_name = Some("dev".into());
        let json = serde_json::to_string(&common).unwrap();
        assert!(json.contains("\"session_class\":\"standalone\""));
        let parsed: ManifestCommon = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, common);
    }

    #[test]
    fn standalone_retirement_policy_roundtrips_as_an_explicit_v1_contract() {
        let mut common = managed_common();
        common.session_class = SessionClass::Standalone;
        common.session_name = Some("dev".into());
        common.retirement_policy = Some(
            SessionRetirementPolicy::AfterGracefulLastClientDepartureV1 {
                grace_period_ms: 5_000,
            },
        );

        let json = serde_json::to_string(&common).unwrap();
        assert!(json.contains("\"kind\":\"after_graceful_last_client_departure_v1\""));
        assert!(json.contains("\"grace_period_ms\":\"5000\""));
        let parsed: ManifestCommon = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, common);
        validate_common(&parsed, &ManifestLimits::default()).unwrap();
    }

    #[test]
    fn retirement_policy_rejects_unknown_versions_and_fields() {
        for policy in [
            serde_json::json!({
                "kind": "after_graceful_last_client_departure_v2",
                "grace_period_ms": "5000"
            }),
            serde_json::json!({
                "kind": "after_graceful_last_client_departure_v1",
                "grace_period_ms": "5000",
                "detach_means_transport_loss": true
            }),
        ] {
            assert!(serde_json::from_value::<SessionRetirementPolicy>(policy).is_err());
        }
    }

    #[test]
    fn retirement_policy_bounds_and_managed_fence_fail_closed() {
        for grace_period_ms in [
            SessionRetirementPolicy::MIN_GRACE_PERIOD_MS - 1,
            SessionRetirementPolicy::MAX_GRACE_PERIOD_MS + 1,
        ] {
            let mut common = managed_common();
            common.session_class = SessionClass::Standalone;
            common.session_name = Some("dev".into());
            common.retirement_policy = Some(
                SessionRetirementPolicy::AfterGracefulLastClientDepartureV1 { grace_period_ms },
            );
            assert_eq!(
                validate_common(&common, &ManifestLimits::default()).unwrap_err(),
                ManifestValidationError::Inconsistent {
                    field: "retirement_policy"
                }
            );
        }

        let mut managed = managed_common();
        managed.retirement_policy = Some(
            SessionRetirementPolicy::AfterGracefulLastClientDepartureV1 {
                grace_period_ms: 5_000,
            },
        );
        assert_eq!(
            validate_common(&managed, &ManifestLimits::default()).unwrap_err(),
            ManifestValidationError::Inconsistent {
                field: "retirement_policy"
            }
        );
    }

    #[test]
    fn standalone_without_name_is_inconsistent() {
        let mut common = managed_common();
        common.session_class = SessionClass::Standalone;
        common.session_name = None;
        let error = validate_common(&common, &ManifestLimits::default()).unwrap_err();
        assert_eq!(
            error,
            ManifestValidationError::Inconsistent {
                field: "session_name"
            }
        );
    }

    #[test]
    fn managed_without_name_validates() {
        validate_common(&managed_common(), &ManifestLimits::default()).unwrap();
    }

    #[test]
    fn provider_ready_may_publish_before_the_first_output() {
        let mut common = managed_common();
        common.session_class = SessionClass::Standalone;
        common.session_name = Some("dev".into());
        let ready = ReadyManifest {
            common,
            provider_process: ProcessProof {
                process_id: 101,
                start_marker: "provider-start".into(),
            },
            terminal_epoch: "terminal-1".into(),
            ready_output_seq: 0,
            endpoint: LocalEndpoint {
                kind: LocalEndpointKind::UnixSocket,
                address: "/tmp/hmux.sock".into(),
            },
            capability_token: "token".into(),
            ready_unix_ms: 2,
        };

        validate_ready(&ready, &ManifestLimits::default()).unwrap();

        let mut managed = ready;
        managed.common = managed_common();
        validate_ready(&managed, &ManifestLimits::default()).unwrap();
    }
}
