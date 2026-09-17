use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use hmux_client::{
    ClientError, EndpointKind, LocalSessionCatalog, SESSION_PROBE_QUANTUM, SessionClass,
    SessionDescriptor, SessionHealth, SessionLifecycle, inspect_local_sessions,
};
use hmux_host::local_discovery::{DiscoveryRegistrationCapacity, ManifestLimits};
use hmux_host::local_protocol::{PROTOCOL_V1, SCREEN_SNAPSHOT_PROFILE_CAPABILITY};
use serde::Serialize;
use sha2::{Digest, Sha256};

pub(crate) const RUNTIME_STATUS_CAPABILITY: &str = "runtime_status_v1";
const STATUS_SCHEMA_VERSION: u32 = 1;
const MAX_PROBE_WORKERS: usize = 8;
const MAX_AUTOMATIC_PROBE_BUDGET: Duration = Duration::from_secs(2);
const SESSION_HOST_SAMPLE_LIMIT: usize = 16;

#[derive(Clone, Copy)]
struct BuildIdentity<'a> {
    package_version: &'a str,
    build_id: &'a str,
    capabilities: &'a [&'a str],
}

#[derive(Clone)]
struct SessionObservation {
    descriptor: SessionDescriptor,
    health: SessionHealth,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeStatus {
    schema_version: u32,
    kind: &'static str,
    status: &'static str,
    reason_codes: Vec<String>,
    observed_at_ms: u64,
    hmux_cli: HmuxCliStatus,
    session_hosts: SessionCensus,
    session_host_sample: Vec<SessionHost>,
    session_host_sample_limit: usize,
    session_host_sample_has_more: bool,
    session_host_sample_omitted_count: usize,
    representative_error: Option<TypedError>,
    resource_pressure: ResourcePressure,
    sources: Vec<SourceStatus>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HmuxCliStatus {
    state: &'static str,
    package_version: String,
    build_id: String,
    protocol: ClientProtocol,
    host: MachineHost,
    observed_at_ms: u64,
    source_age_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProtocolVersion {
    major: u16,
    minor: u16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientProtocol {
    minimum: ProtocolVersion,
    maximum: ProtocolVersion,
    capabilities: Vec<String>,
    required_host_capabilities: Vec<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MachineHost {
    id: &'static str,
    name: Option<String>,
    os: &'static str,
    architecture: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionCensus {
    state: &'static str,
    complete: bool,
    snapshot_id: Option<String>,
    probe_budget_ms: u64,
    total: usize,
    active: usize,
    exited: usize,
    probed: usize,
    unprobed: usize,
    probe_coverage_basis_points: u16,
    healthy: usize,
    degraded: usize,
    outdated: usize,
    stale: usize,
    provider_counts: BTreeMap<String, usize>,
    build_counts: BTreeMap<String, usize>,
    build_count_basis: &'static str,
    reason_counts: BTreeMap<String, usize>,
    build_skew: bool,
    observed_at_ms: u64,
    manifest_max_lifecycle_age_ms: u64,
    registration_capacity: RegistrationCapacity,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct RegistrationCapacity {
    state: &'static str,
    used: Option<usize>,
    maximum: usize,
    remaining: Option<usize>,
}

impl From<DiscoveryRegistrationCapacity> for RegistrationCapacity {
    fn from(capacity: DiscoveryRegistrationCapacity) -> Self {
        Self {
            state: "available",
            used: Some(capacity.used),
            maximum: capacity.maximum,
            remaining: Some(capacity.remaining),
        }
    }
}

impl RegistrationCapacity {
    fn unavailable() -> Self {
        Self {
            state: "unavailable",
            used: None,
            maximum: ManifestLimits::default().max_session_catalog_entries,
            remaining: None,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionHost {
    session_id: String,
    workspace_id: String,
    session_class: &'static str,
    lifecycle: &'static str,
    health: &'static str,
    provider_id: String,
    host: SessionHostIdentity,
    process: SessionProcesses,
    endpoint: Endpoint,
    protocol: HostProtocol,
    probe: ProbeObservation,
    manifest_lifecycle_age_ms: Option<u64>,
    observation_error: Option<TypedError>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionHostIdentity {
    runtime_host: Option<String>,
    runner_principal: String,
    runner_instance: String,
    channel_epoch: String,
    host_instance_id: String,
    terminal_epoch: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessGeneration {
    process_id: u32,
    start_marker: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionProcesses {
    host: ProcessGeneration,
    provider: ProcessGeneration,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Endpoint {
    kind: &'static str,
    id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostProtocol {
    minimum: ProtocolVersion,
    maximum: ProtocolVersion,
    capabilities: Vec<String>,
    negotiation: &'static str,
    missing_capabilities: Vec<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeObservation {
    state: &'static str,
    observed_at_ms: Option<u64>,
    age_ms: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TypedError {
    code: String,
    message: &'static str,
    source: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResourcePressure {
    state: &'static str,
    level: &'static str,
    basis: &'static str,
    one_minute_load: Option<f64>,
    load_per_logical_core: Option<f64>,
    logical_cores: Option<usize>,
    physical_memory_bytes: Option<u64>,
    producer_peak_resident_bytes: Option<u64>,
    observed_at_ms: u64,
    source_age_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceStatus {
    name: &'static str,
    state: &'static str,
    observed_at_ms: u64,
    source_age_ms: u64,
    reason_code: Option<String>,
}

pub(crate) fn collect(
    catalog: Result<LocalSessionCatalog, ClientError>,
    probe_budget: Option<Duration>,
    package_version: &'static str,
    build_id: &'static str,
    capabilities: &'static [&'static str],
) -> RuntimeStatus {
    let identity = BuildIdentity {
        package_version,
        build_id,
        capabilities,
    };
    let catalog = match catalog {
        Ok(catalog) => catalog,
        Err(error) => {
            let observed_at_ms = unix_ms();
            return unavailable(
                identity,
                observed_at_ms,
                probe_budget.unwrap_or_default(),
                error.code(),
                "backend discovery root is unavailable",
                resource_pressure(observed_at_ms),
            );
        }
    };
    let registration_capacity = match catalog.registration_capacity() {
        Ok(capacity) => capacity,
        Err(error) => {
            let observed_at_ms = unix_ms();
            return unavailable(
                identity,
                observed_at_ms,
                probe_budget.unwrap_or_default(),
                error.code(),
                "backend registration capacity is unavailable",
                resource_pressure(observed_at_ms),
            );
        }
    };
    let descriptors = match catalog.list() {
        Ok(descriptors) => descriptors,
        Err(error) => {
            let observed_at_ms = unix_ms();
            return unavailable(
                identity,
                observed_at_ms,
                probe_budget.unwrap_or_default(),
                error.code(),
                "backend session catalog is unavailable",
                resource_pressure(observed_at_ms),
            );
        }
    };
    let probe_budget = selected_probe_budget(
        probe_budget,
        descriptors
            .iter()
            .filter(|descriptor| descriptor.lifecycle == SessionLifecycle::Ready)
            .count(),
    );
    let inspections =
        inspect_local_sessions(&catalog, descriptors, MAX_PROBE_WORKERS, probe_budget);
    let observations = inspections
        .into_iter()
        .map(|inspection| SessionObservation {
            descriptor: inspection.descriptor,
            health: inspection.health,
        })
        .collect();
    let observed_at_ms = unix_ms();
    summarize(
        identity,
        observed_at_ms,
        probe_budget,
        observations,
        registration_capacity,
        resource_pressure(observed_at_ms),
    )
}

fn selected_probe_budget(explicit: Option<Duration>, active_sessions: usize) -> Duration {
    explicit.unwrap_or_else(|| {
        let waves = active_sessions.div_ceil(MAX_PROBE_WORKERS);
        SESSION_PROBE_QUANTUM
            .saturating_mul(u32::try_from(waves).unwrap_or(u32::MAX))
            .min(MAX_AUTOMATIC_PROBE_BUDGET)
    })
}

fn summarize(
    identity: BuildIdentity<'_>,
    observed_at_ms: u64,
    probe_budget: Duration,
    observations: Vec<SessionObservation>,
    registration_capacity: DiscoveryRegistrationCapacity,
    resource_pressure: ResourcePressure,
) -> RuntimeStatus {
    let mut reasons = BTreeSet::new();
    let mut provider_counts = BTreeMap::new();
    let mut build_counts = BTreeMap::new();
    let mut reason_counts = BTreeMap::new();
    let mut active = 0;
    let mut exited = 0;
    let mut unprobed = 0;
    let mut healthy = 0;
    let mut degraded = 0;
    let mut outdated = 0;
    let mut stale = 0;
    let mut maximum_manifest_lifecycle_age = 0;
    let total = observations.len();
    let snapshot_id = census_snapshot_id(&observations);
    let mut projected_hosts = Vec::with_capacity(total);

    for observation in observations {
        let descriptor = observation.descriptor;
        let manifest_lifecycle_age_ms = descriptor
            .lifecycle_changed_unix_ms
            .parse::<u64>()
            .ok()
            .map(|changed| observed_at_ms.saturating_sub(changed));
        if let Some(age) = manifest_lifecycle_age_ms {
            maximum_manifest_lifecycle_age = maximum_manifest_lifecycle_age.max(age);
        }
        *provider_counts
            .entry(descriptor.provider_id.clone())
            .or_insert(0) += 1;
        match descriptor.lifecycle {
            SessionLifecycle::Ready => {
                active += 1;
                *build_counts
                    .entry(descriptor.host_build_version.clone())
                    .or_insert(0) += 1;
            }
            SessionLifecycle::Exited => exited += 1,
        }
        let missing_capabilities = if descriptor.lifecycle == SessionLifecycle::Ready
            && !descriptor
                .capabilities
                .iter()
                .any(|capability| capability == SCREEN_SNAPSHOT_PROFILE_CAPABILITY)
        {
            vec![SCREEN_SNAPSHOT_PROFILE_CAPABILITY]
        } else {
            Vec::new()
        };
        let (health, negotiation, probe_state, error) =
            project_health(observation.health, !missing_capabilities.is_empty());
        if observation.health == SessionHealth::Unprobed {
            unprobed += 1;
        }
        match health {
            "healthy" => healthy += 1,
            "degraded" => degraded += 1,
            "outdated" => outdated += 1,
            "stale" => stale += 1,
            "exited" => {}
            _ => unreachable!("health projection is closed"),
        }
        if let Some(error) = error.as_ref() {
            reasons.insert(error.code.to_string());
            *reason_counts.entry(error.code.to_string()).or_insert(0) += 1;
        }
        let endpoint_kind = match descriptor.endpoint.kind {
            EndpointKind::UnixSocket => "unix_socket",
            EndpointKind::WindowsNamedPipe => "windows_named_pipe",
        };
        let endpoint_id = endpoint_id(&descriptor.endpoint.address);
        projected_hosts.push(SessionHost {
            session_id: descriptor.session_id,
            workspace_id: descriptor.workspace_id,
            session_class: match descriptor.session_class {
                SessionClass::Managed => "managed",
                SessionClass::Standalone => "standalone",
            },
            lifecycle: match descriptor.lifecycle {
                SessionLifecycle::Ready => "ready",
                SessionLifecycle::Exited => "exited",
            },
            health,
            provider_id: descriptor.provider_id,
            host: SessionHostIdentity {
                runtime_host: descriptor.runtime_host,
                runner_principal: descriptor.runner_principal,
                runner_instance: descriptor.runner_instance,
                channel_epoch: descriptor.channel_epoch,
                host_instance_id: descriptor.host_instance_id,
                terminal_epoch: descriptor.terminal_epoch,
            },
            process: SessionProcesses {
                host: ProcessGeneration {
                    process_id: descriptor.host_process.process_id,
                    start_marker: descriptor.host_process.start_marker,
                },
                provider: ProcessGeneration {
                    process_id: descriptor.provider_process.process_id,
                    start_marker: descriptor.provider_process.start_marker,
                },
            },
            endpoint: Endpoint {
                kind: endpoint_kind,
                id: endpoint_id,
            },
            protocol: HostProtocol {
                minimum: ProtocolVersion {
                    major: descriptor.supported_protocol.minimum.major,
                    minor: descriptor.supported_protocol.minimum.minor,
                },
                maximum: ProtocolVersion {
                    major: descriptor.supported_protocol.maximum.major,
                    minor: descriptor.supported_protocol.maximum.minor,
                },
                capabilities: descriptor.capabilities,
                negotiation,
                missing_capabilities,
            },
            probe: ProbeObservation {
                state: probe_state,
                observed_at_ms: (probe_state == "fresh").then_some(observed_at_ms),
                age_ms: (probe_state == "fresh").then_some(0),
            },
            manifest_lifecycle_age_ms,
            observation_error: error,
        });
    }
    projected_hosts.sort_by(|left, right| {
        sample_priority(left.health)
            .cmp(&sample_priority(right.health))
            .then_with(|| left.session_id.cmp(&right.session_id))
            .then_with(|| left.workspace_id.cmp(&right.workspace_id))
    });
    let omitted_count = projected_hosts
        .len()
        .saturating_sub(SESSION_HOST_SAMPLE_LIMIT);
    projected_hosts.truncate(SESSION_HOST_SAMPLE_LIMIT);
    let representative_error = projected_hosts
        .iter()
        .find_map(|host| host.observation_error.clone());
    let session_host_state = if stale > 0 {
        "stale"
    } else if outdated > 0 {
        "outdated"
    } else if degraded > 0 {
        "degraded"
    } else {
        "ready"
    };
    if resource_pressure.state != "available" {
        reasons.insert("hmux_resource_pressure_unavailable".to_string());
    } else if resource_pressure.level == "critical" {
        reasons.insert("hmux_resource_pressure_critical".to_string());
    }
    let (resource_source_state, resource_reason_code) = if resource_pressure.state != "available" {
        ("unavailable", Some("hmux_resource_pressure_unavailable"))
    } else if resource_pressure.level == "critical" {
        ("degraded", Some("hmux_resource_pressure_critical"))
    } else {
        ("ready", None)
    };
    // Per-session stale/outdated facts degrade this fresh Hmux observation;
    // they never turn the report source itself stale. Dure composes any
    // orchestration control-plane status outside this neutral Hmux contract.
    let status = if reasons.is_empty() {
        "ready"
    } else {
        "degraded"
    };
    RuntimeStatus {
        schema_version: STATUS_SCHEMA_VERSION,
        kind: "hmux.runtime_status",
        status,
        reason_codes: reasons.into_iter().collect(),
        observed_at_ms,
        hmux_cli: HmuxCliStatus {
            state: "ready",
            package_version: identity.package_version.to_string(),
            build_id: identity.build_id.to_string(),
            protocol: ClientProtocol {
                minimum: ProtocolVersion {
                    major: PROTOCOL_V1.major,
                    minor: PROTOCOL_V1.minor,
                },
                maximum: ProtocolVersion {
                    major: PROTOCOL_V1.major,
                    minor: PROTOCOL_V1.minor,
                },
                capabilities: identity
                    .capabilities
                    .iter()
                    .map(|capability| (*capability).to_string())
                    .collect(),
                required_host_capabilities: vec![SCREEN_SNAPSHOT_PROFILE_CAPABILITY],
            },
            host: MachineHost {
                id: "local",
                name: host_name(),
                os: std::env::consts::OS,
                architecture: std::env::consts::ARCH,
            },
            observed_at_ms,
            source_age_ms: 0,
        },
        session_hosts: SessionCensus {
            state: session_host_state,
            complete: unprobed == 0,
            snapshot_id: Some(snapshot_id),
            probe_budget_ms: duration_ms(probe_budget),
            total,
            active,
            exited,
            probed: active.saturating_sub(unprobed),
            unprobed,
            probe_coverage_basis_points: probe_coverage_basis_points(
                active.saturating_sub(unprobed),
                active,
            ),
            healthy,
            degraded,
            outdated,
            stale,
            provider_counts,
            reason_counts,
            build_count_basis: "active_ready",
            build_skew: build_counts.len() > 1,
            build_counts,
            observed_at_ms,
            manifest_max_lifecycle_age_ms: maximum_manifest_lifecycle_age,
            registration_capacity: registration_capacity.into(),
        },
        session_host_sample: projected_hosts,
        session_host_sample_limit: SESSION_HOST_SAMPLE_LIMIT,
        session_host_sample_has_more: omitted_count > 0,
        session_host_sample_omitted_count: omitted_count,
        representative_error,
        sources: vec![
            SourceStatus {
                name: "hmux_cli",
                state: "ready",
                observed_at_ms,
                source_age_ms: 0,
                reason_code: None,
            },
            SourceStatus {
                name: "session_hosts",
                state: session_host_state,
                observed_at_ms,
                source_age_ms: 0,
                reason_code: None,
            },
            SourceStatus {
                name: "resource_pressure",
                state: resource_source_state,
                observed_at_ms,
                source_age_ms: 0,
                reason_code: resource_reason_code.map(str::to_owned),
            },
        ],
        resource_pressure,
    }
}

fn project_health(
    health: SessionHealth,
    capability_outdated: bool,
) -> (&'static str, &'static str, &'static str, Option<TypedError>) {
    if capability_outdated && health == SessionHealth::Healthy {
        return (
            "outdated",
            "capability_outdated",
            "fresh",
            Some(TypedError {
                code: "hmux_host_capability_outdated".into(),
                message: "session Host lacks a required observation capability",
                source: "host_negotiation",
            }),
        );
    }
    match health {
        SessionHealth::Healthy => ("healthy", "accepted", "fresh", None),
        SessionHealth::StaleTransport => (
            "stale",
            "unavailable",
            "stale",
            Some(TypedError {
                code: "hmux_session_transport_stale".into(),
                message: "session Host did not complete a bounded observer handshake",
                source: "host_probe",
            }),
        ),
        SessionHealth::IncompatibleProtocol => (
            "outdated",
            "incompatible",
            "unknown",
            Some(TypedError {
                code: "hmux_protocol_outdated".into(),
                message: "session Host protocol or capability negotiation is incompatible",
                source: "host_negotiation",
            }),
        ),
        SessionHealth::GenerationChanged => (
            "stale",
            "generation_changed",
            "stale",
            Some(TypedError {
                code: "hmux_process_generation_changed".into(),
                message: "session endpoint answered with a different Host or process generation",
                source: "host_probe",
            }),
        ),
        SessionHealth::Unprobed => (
            "degraded",
            "deadline_exhausted",
            "unknown",
            Some(TypedError {
                code: "hmux_probe_deadline_exhausted".into(),
                message: "global probe budget ended before this session was observed",
                source: "host_probe",
            }),
        ),
        SessionHealth::Exited => ("exited", "not_applicable", "stopped", None),
    }
}

fn sample_priority(health: &str) -> u8 {
    match health {
        "stale" => 0,
        "outdated" => 1,
        "degraded" => 2,
        "healthy" => 3,
        "exited" => 4,
        _ => 5,
    }
}

fn unavailable(
    identity: BuildIdentity<'_>,
    observed_at_ms: u64,
    probe_budget: Duration,
    code: &str,
    message: &'static str,
    resource_pressure: ResourcePressure,
) -> RuntimeStatus {
    RuntimeStatus {
        schema_version: STATUS_SCHEMA_VERSION,
        kind: "hmux.runtime_status",
        status: "unreachable",
        reason_codes: vec![code.to_string()],
        observed_at_ms,
        hmux_cli: HmuxCliStatus {
            state: "ready",
            package_version: identity.package_version.to_string(),
            build_id: identity.build_id.to_string(),
            protocol: ClientProtocol {
                minimum: ProtocolVersion {
                    major: PROTOCOL_V1.major,
                    minor: PROTOCOL_V1.minor,
                },
                maximum: ProtocolVersion {
                    major: PROTOCOL_V1.major,
                    minor: PROTOCOL_V1.minor,
                },
                capabilities: identity
                    .capabilities
                    .iter()
                    .map(|capability| (*capability).to_string())
                    .collect(),
                required_host_capabilities: vec![SCREEN_SNAPSHOT_PROFILE_CAPABILITY],
            },
            host: MachineHost {
                id: "local",
                name: host_name(),
                os: std::env::consts::OS,
                architecture: std::env::consts::ARCH,
            },
            observed_at_ms,
            source_age_ms: 0,
        },
        session_hosts: SessionCensus {
            state: "unreachable",
            complete: false,
            snapshot_id: None,
            probe_budget_ms: duration_ms(probe_budget),
            total: 0,
            active: 0,
            exited: 0,
            probed: 0,
            unprobed: 0,
            probe_coverage_basis_points: 0,
            healthy: 0,
            degraded: 0,
            outdated: 0,
            stale: 0,
            provider_counts: BTreeMap::new(),
            build_counts: BTreeMap::new(),
            build_count_basis: "active_ready",
            reason_counts: BTreeMap::new(),
            build_skew: false,
            observed_at_ms,
            manifest_max_lifecycle_age_ms: 0,
            registration_capacity: RegistrationCapacity::unavailable(),
        },
        session_host_sample: Vec::new(),
        session_host_sample_limit: SESSION_HOST_SAMPLE_LIMIT,
        session_host_sample_has_more: false,
        session_host_sample_omitted_count: 0,
        representative_error: Some(TypedError {
            code: code.to_owned(),
            message,
            source: "session_catalog",
        }),
        resource_pressure,
        sources: vec![
            SourceStatus {
                name: "hmux_cli",
                state: "ready",
                observed_at_ms,
                source_age_ms: 0,
                reason_code: None,
            },
            SourceStatus {
                name: "session_hosts",
                state: "unreachable",
                observed_at_ms,
                source_age_ms: 0,
                reason_code: Some(code.to_owned()),
            },
        ],
    }
}

fn probe_coverage_basis_points(probed: usize, targets: usize) -> u16 {
    if targets == 0 {
        return 10_000;
    }
    u16::try_from(
        probed
            .saturating_mul(10_000)
            .checked_div(targets)
            .unwrap_or_default()
            .min(10_000),
    )
    .unwrap_or(10_000)
}

pub(crate) fn render(status: &RuntimeStatus) -> String {
    format!(
        concat!(
            "Hmux runtime: {}\n",
            "  build: {}\n",
            "  host: {}\n",
            "  sessions: {}/{} active\n",
            "  registration capacity: {}/{} ({} remaining)\n",
            "  providers: {}\n",
            "  resource pressure: {}\n",
            "  reasons: {}\n"
        ),
        status.status,
        status.hmux_cli.build_id,
        status.hmux_cli.host.name.as_deref().unwrap_or("unknown"),
        status.session_hosts.active,
        status.session_hosts.total,
        status
            .session_hosts
            .registration_capacity
            .used
            .map_or_else(|| "unknown".to_string(), |used| used.to_string()),
        status.session_hosts.registration_capacity.maximum,
        status
            .session_hosts
            .registration_capacity
            .remaining
            .map_or_else(|| "unknown".to_string(), |remaining| remaining.to_string()),
        status
            .session_hosts
            .provider_counts
            .iter()
            .map(|(provider, count)| format!("{provider}={count}"))
            .collect::<Vec<_>>()
            .join(","),
        status.resource_pressure.level,
        if status.reason_codes.is_empty() {
            "none".to_string()
        } else {
            status.reason_codes.join(",")
        },
    )
}

fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
        .unwrap_or(0)
}

fn endpoint_id(address: &str) -> String {
    let digest = Sha256::digest(address.as_bytes());
    let mut id = String::with_capacity(18);
    id.push_str("e_");
    for byte in digest.iter().take(8) {
        use std::fmt::Write as _;
        let _ = write!(id, "{byte:02x}");
    }
    id
}

fn duration_ms(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn census_snapshot_id(observations: &[SessionObservation]) -> String {
    let mut descriptors = observations
        .iter()
        .map(|observation| &observation.descriptor)
        .collect::<Vec<_>>();
    descriptors.sort_by(|left, right| {
        left.workspace_id
            .cmp(&right.workspace_id)
            .then_with(|| left.session_id.cmp(&right.session_id))
            .then_with(|| left.runner_principal.cmp(&right.runner_principal))
            .then_with(|| left.runner_instance.cmp(&right.runner_instance))
            .then_with(|| left.channel_epoch.cmp(&right.channel_epoch))
            .then_with(|| left.host_instance_id.cmp(&right.host_instance_id))
            .then_with(|| left.terminal_epoch.cmp(&right.terminal_epoch))
            .then_with(|| {
                left.host_process
                    .process_id
                    .cmp(&right.host_process.process_id)
            })
            .then_with(|| {
                left.host_process
                    .start_marker
                    .cmp(&right.host_process.start_marker)
            })
            .then_with(|| {
                left.provider_process
                    .process_id
                    .cmp(&right.provider_process.process_id)
            })
            .then_with(|| {
                left.provider_process
                    .start_marker
                    .cmp(&right.provider_process.start_marker)
            })
            .then_with(|| snapshot_lifecycle(left).cmp(snapshot_lifecycle(right)))
            .then_with(|| snapshot_endpoint_kind(left).cmp(snapshot_endpoint_kind(right)))
            .then_with(|| left.endpoint.address.cmp(&right.endpoint.address))
    });
    let mut digest = Sha256::new();
    digest.update(b"hmux.runtime_status.census.v1\0");
    for descriptor in descriptors {
        hash_snapshot_field(&mut digest, &descriptor.workspace_id);
        hash_snapshot_field(&mut digest, &descriptor.session_id);
        hash_snapshot_field(&mut digest, &descriptor.runner_principal);
        hash_snapshot_field(&mut digest, &descriptor.runner_instance);
        hash_snapshot_field(&mut digest, &descriptor.channel_epoch);
        hash_snapshot_field(&mut digest, &descriptor.host_instance_id);
        hash_snapshot_field(&mut digest, &descriptor.terminal_epoch);
        hash_snapshot_field(&mut digest, snapshot_lifecycle(descriptor));
        digest.update(descriptor.host_process.process_id.to_be_bytes());
        hash_snapshot_field(&mut digest, &descriptor.host_process.start_marker);
        digest.update(descriptor.provider_process.process_id.to_be_bytes());
        hash_snapshot_field(&mut digest, &descriptor.provider_process.start_marker);
        hash_snapshot_field(&mut digest, snapshot_endpoint_kind(descriptor));
        hash_snapshot_field(&mut digest, &descriptor.endpoint.address);
    }
    let bytes = digest.finalize();
    let mut id = String::with_capacity(66);
    id.push_str("c_");
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(id, "{byte:02x}");
    }
    id
}

fn snapshot_lifecycle(descriptor: &SessionDescriptor) -> &'static str {
    match descriptor.lifecycle {
        SessionLifecycle::Ready => "ready",
        SessionLifecycle::Exited => "exited",
    }
}

fn snapshot_endpoint_kind(descriptor: &SessionDescriptor) -> &'static str {
    match descriptor.endpoint.kind {
        EndpointKind::UnixSocket => "unix_socket",
        EndpointKind::WindowsNamedPipe => "windows_named_pipe",
    }
}

fn hash_snapshot_field(digest: &mut Sha256, value: &str) {
    digest.update(u64::try_from(value.len()).unwrap_or(u64::MAX).to_be_bytes());
    digest.update(value.as_bytes());
}

#[cfg(unix)]
fn host_name() -> Option<String> {
    let mut bytes = [0_u8; 256];
    // SAFETY: the writable byte buffer remains valid for the call and its
    // exact length is supplied.
    if unsafe { libc::gethostname(bytes.as_mut_ptr().cast(), bytes.len()) } != 0 {
        return None;
    }
    let length = bytes
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(bytes.len());
    let value = String::from_utf8_lossy(&bytes[..length]).trim().to_string();
    (!value.is_empty()).then_some(value)
}

#[cfg(not(unix))]
fn host_name() -> Option<String> {
    None
}

#[cfg(unix)]
fn one_minute_load() -> Option<f64> {
    let mut load = [0.0_f64; 1];
    // SAFETY: getloadavg writes at most the explicitly supplied one f64.
    let count = unsafe { libc::getloadavg(load.as_mut_ptr(), 1) };
    (count == 1 && load[0].is_finite() && load[0] >= 0.0).then_some(load[0])
}

#[cfg(not(unix))]
fn one_minute_load() -> Option<f64> {
    None
}

#[cfg(target_os = "macos")]
fn physical_memory_bytes() -> Option<u64> {
    let mut bytes = 0_u64;
    let mut size = std::mem::size_of::<u64>();
    // SAFETY: hw.memsize writes one u64 into the supplied output buffer.
    let status = unsafe {
        libc::sysctlbyname(
            c"hw.memsize".as_ptr(),
            (&raw mut bytes).cast(),
            &raw mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    (status == 0 && size == std::mem::size_of::<u64>() && bytes > 0).then_some(bytes)
}

#[cfg(target_os = "linux")]
fn physical_memory_bytes() -> Option<u64> {
    // SAFETY: sysconf reads process-global immutable configuration values.
    let pages = unsafe { libc::sysconf(libc::_SC_PHYS_PAGES) };
    // SAFETY: same as above.
    let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    u64::try_from(pages)
        .ok()?
        .checked_mul(u64::try_from(page_size).ok()?)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn physical_memory_bytes() -> Option<u64> {
    None
}

#[cfg(unix)]
fn peak_resident_bytes() -> Option<u64> {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
    // SAFETY: getrusage initializes the supplied structure on success.
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) } != 0 {
        return None;
    }
    // SAFETY: the successful call above initialized the structure.
    let resident = u64::try_from(unsafe { usage.assume_init() }.ru_maxrss).ok()?;
    #[cfg(target_os = "macos")]
    return Some(resident);
    #[cfg(not(target_os = "macos"))]
    return resident.checked_mul(1024);
}

#[cfg(not(unix))]
fn peak_resident_bytes() -> Option<u64> {
    None
}

fn resource_pressure(observed_at_ms: u64) -> ResourcePressure {
    let logical_cores = std::thread::available_parallelism()
        .ok()
        .map(std::num::NonZeroUsize::get);
    let load = one_minute_load();
    let load_per_core = load
        .zip(logical_cores)
        .map(|(value, cores)| value / cores as f64);
    let level = match load_per_core {
        Some(value) if value <= 1.0 => "normal",
        Some(value) if value <= 2.0 => "elevated",
        Some(_) => "critical",
        None => "unknown",
    };
    ResourcePressure {
        state: if level == "unknown" {
            "unavailable"
        } else {
            "available"
        },
        level,
        basis: "load_average_per_logical_core",
        one_minute_load: load,
        load_per_logical_core: load_per_core,
        logical_cores,
        physical_memory_bytes: physical_memory_bytes(),
        producer_peak_resident_bytes: peak_resident_bytes(),
        observed_at_ms,
        source_age_ms: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hmux_client::{ProcessDescriptor, ProtocolVersion, VersionRange};

    const CAPABILITIES: &[&str] = &[RUNTIME_STATUS_CAPABILITY];

    fn descriptor(capabilities: &[&str]) -> SessionDescriptor {
        SessionDescriptor {
            schema_version: 1,
            session_id: "session-1".into(),
            session_name: Some("fixture".into()),
            workspace_id: "workspace-1".into(),
            session_class: SessionClass::Standalone,
            lifecycle: SessionLifecycle::Ready,
            provider_id: "fixture-provider".into(),
            runtime_host: None,
            worktree_alias: None,
            branch: None,
            launch_program: None,
            runner_principal: "runner".into(),
            runner_instance: "runner-1".into(),
            channel_epoch: "1".into(),
            host_instance_id: "host-1".into(),
            terminal_epoch: "terminal-1".into(),
            output_seq: "1".into(),
            host_build_version: "host-build".into(),
            supported_protocol: VersionRange {
                minimum: ProtocolVersion { major: 1, minor: 0 },
                maximum: ProtocolVersion { major: 1, minor: 0 },
            },
            capabilities: capabilities.iter().map(|value| (*value).into()).collect(),
            retirement_policy: None,
            host_process: ProcessDescriptor {
                process_id: 42,
                start_marker: "host-start-generation-1".into(),
            },
            provider_process: ProcessDescriptor {
                process_id: 43,
                start_marker: "provider-start-generation-1".into(),
            },
            endpoint: hmux_client::EndpointDescriptor {
                kind: EndpointKind::UnixSocket,
                address: "/private/runtime/session.sock".into(),
            },
            created_unix_ms: "1".into(),
            lifecycle_changed_unix_ms: "900".into(),
            exit: None,
            failure: None,
        }
    }

    fn resource(observed_at_ms: u64) -> ResourcePressure {
        ResourcePressure {
            state: "available",
            level: "normal",
            basis: "fixture",
            one_minute_load: Some(1.0),
            load_per_logical_core: Some(0.1),
            logical_cores: Some(10),
            physical_memory_bytes: Some(1024),
            producer_peak_resident_bytes: Some(128),
            observed_at_ms,
            source_age_ms: 0,
        }
    }

    fn registration_capacity() -> DiscoveryRegistrationCapacity {
        DiscoveryRegistrationCapacity {
            used: 1,
            maximum: 1_024,
            remaining: 1_023,
        }
    }

    #[test]
    fn default_probe_budget_scales_with_the_active_census_and_stays_bounded() {
        assert_eq!(selected_probe_budget(None, 0), Duration::ZERO);
        assert_eq!(selected_probe_budget(None, 1), Duration::from_millis(500));
        assert_eq!(selected_probe_budget(None, 8), Duration::from_millis(500));
        assert_eq!(selected_probe_budget(None, 9), Duration::from_secs(1));
        assert_eq!(
            selected_probe_budget(None, usize::MAX),
            Duration::from_secs(2)
        );
        assert_eq!(
            selected_probe_budget(Some(Duration::from_millis(125)), usize::MAX),
            Duration::from_millis(125)
        );
    }

    fn report(health: SessionHealth, host_capabilities: &[&str]) -> serde_json::Value {
        serde_json::to_value(summarize(
            BuildIdentity {
                package_version: "0.1.4",
                build_id: "cli-build",
                capabilities: CAPABILITIES,
            },
            1_000,
            Duration::from_millis(125),
            vec![SessionObservation {
                descriptor: descriptor(host_capabilities),
                health,
            }],
            registration_capacity(),
            resource(1_000),
        ))
        .unwrap()
    }

    #[test]
    fn status_preserves_exact_process_generation_and_redacts_the_socket() {
        let report = report(
            SessionHealth::Healthy,
            &[SCREEN_SNAPSHOT_PROFILE_CAPABILITY],
        );
        assert_eq!(report["schemaVersion"], 1);
        assert_eq!(report["kind"], "hmux.runtime_status");
        assert_eq!(report["status"], "ready");
        assert_eq!(
            report["sessionHostSample"][0]["process"]["host"]["processId"],
            42
        );
        assert_eq!(
            report["sessionHostSample"][0]["process"]["host"]["startMarker"],
            "host-start-generation-1"
        );
        assert_eq!(
            report["sessionHostSample"][0]["endpoint"]["id"],
            endpoint_id("/private/runtime/session.sock")
        );
        assert!(
            report["sessionHostSample"][0]["endpoint"]
                .get("address")
                .is_none()
        );
        assert_eq!(report["sessionHostSample"][0]["probe"]["ageMs"], 0);
        assert!(report["sessionHostSample"][0].get("heartbeat").is_none());
        assert_eq!(report["hmuxCli"]["sourceAgeMs"], 0);
        assert_eq!(report["sessionHosts"]["manifestMaxLifecycleAgeMs"], 100);
        assert_eq!(
            report["sessionHosts"]["registrationCapacity"],
            serde_json::json!({
                "state": "available",
                "used": 1,
                "maximum": 1_024,
                "remaining": 1_023,
            })
        );
        assert_eq!(
            report["sessionHosts"]["providerCounts"]["fixture-provider"],
            1
        );
        assert!(report.get("controlPlane").is_none());
    }

    #[test]
    fn pid_reuse_or_socket_replacement_is_a_generation_change_not_health() {
        let report = report(
            SessionHealth::GenerationChanged,
            &[SCREEN_SNAPSHOT_PROFILE_CAPABILITY],
        );
        assert_eq!(report["status"], "degraded");
        assert_eq!(
            report["reasonCodes"],
            serde_json::json!(["hmux_process_generation_changed"])
        );
        assert_eq!(
            report["sessionHostSample"][0]["observationError"]["code"],
            "hmux_process_generation_changed"
        );
        assert_eq!(
            report["sessionHostSample"][0]["probe"]["ageMs"],
            serde_json::Value::Null
        );
        assert_eq!(report["sessionHosts"]["state"], "stale");
        assert_eq!(
            report["representativeError"]["code"],
            "hmux_process_generation_changed"
        );
        assert!(report.get("lastTypedError").is_none());
    }

    #[test]
    fn missing_observation_capability_is_outdated() {
        let report = report(SessionHealth::Healthy, &[]);
        assert_eq!(report["status"], "degraded");
        assert_eq!(
            report["reasonCodes"],
            serde_json::json!(["hmux_host_capability_outdated"])
        );
        assert_eq!(
            report["sessionHostSample"][0]["protocol"]["missingCapabilities"],
            serde_json::json!([SCREEN_SNAPSHOT_PROFILE_CAPABILITY])
        );
    }

    #[test]
    fn exhausted_budget_stays_explicitly_partial() {
        let report = report(
            SessionHealth::Unprobed,
            &[SCREEN_SNAPSHOT_PROFILE_CAPABILITY],
        );
        assert_eq!(report["status"], "degraded");
        assert_eq!(
            report["reasonCodes"],
            serde_json::json!(["hmux_probe_deadline_exhausted"])
        );
        assert_eq!(report["sessionHostSample"][0]["probe"]["state"], "unknown");
        assert_eq!(report["sessionHosts"]["degraded"], 1);
        assert_eq!(report["sessionHosts"]["complete"], false);
        assert_eq!(report["sessionHosts"]["probed"], 0);
        assert_eq!(report["sessionHosts"]["unprobed"], 1);
        assert_eq!(report["sessionHosts"]["probeBudgetMs"], 125);
        assert_eq!(report["sessionHosts"]["probeCoverageBasisPoints"], 0);
        assert!(
            report["sessionHosts"]["snapshotId"]
                .as_str()
                .is_some_and(|value| value.starts_with("c_"))
        );
    }

    #[test]
    fn complete_probe_coverage_is_reported_without_floating_point() {
        let report = report(
            SessionHealth::Healthy,
            &[SCREEN_SNAPSHOT_PROFILE_CAPABILITY],
        );

        assert_eq!(report["sessionHosts"]["probeCoverageBasisPoints"], 10_000);
    }

    #[test]
    fn snapshot_identity_tracks_manifest_generation_not_probe_outcome() {
        let healthy = report(
            SessionHealth::Healthy,
            &[SCREEN_SNAPSHOT_PROFILE_CAPABILITY],
        );
        let unprobed = report(
            SessionHealth::Unprobed,
            &[SCREEN_SNAPSHOT_PROFILE_CAPABILITY],
        );

        assert_eq!(
            healthy["sessionHosts"]["snapshotId"],
            unprobed["sessionHosts"]["snapshotId"]
        );
        assert_eq!(healthy["sessionHosts"]["complete"], true);
        assert_eq!(unprobed["sessionHosts"]["complete"], false);

        let original = descriptor(&[SCREEN_SNAPSHOT_PROFILE_CAPABILITY]);
        let mut replacement = original.clone();
        replacement.host_instance_id = "replacement-host".into();
        let forward = vec![
            SessionObservation {
                descriptor: original.clone(),
                health: SessionHealth::Healthy,
            },
            SessionObservation {
                descriptor: replacement.clone(),
                health: SessionHealth::StaleTransport,
            },
        ];
        let reverse = vec![forward[1].clone(), forward[0].clone()];
        assert_eq!(census_snapshot_id(&forward), census_snapshot_id(&reverse));
        assert_ne!(
            census_snapshot_id(&[SessionObservation {
                descriptor: original,
                health: SessionHealth::Healthy,
            }]),
            census_snapshot_id(&[SessionObservation {
                descriptor: replacement,
                health: SessionHealth::Healthy,
            }])
        );
    }

    #[test]
    fn bounded_sample_prioritizes_unhealthy_hosts_deterministically() {
        let mut observations = Vec::new();
        for index in 0..SESSION_HOST_SAMPLE_LIMIT {
            let mut descriptor = descriptor(&[SCREEN_SNAPSHOT_PROFILE_CAPABILITY]);
            descriptor.session_id = format!("healthy-{index:02}");
            descriptor.workspace_id = format!("workspace-{index:02}");
            observations.push(SessionObservation {
                descriptor,
                health: SessionHealth::Healthy,
            });
        }
        let mut stale_descriptor = descriptor(&[SCREEN_SNAPSHOT_PROFILE_CAPABILITY]);
        stale_descriptor.session_id = "z-stale".into();
        stale_descriptor.workspace_id = "workspace-z".into();
        observations.push(SessionObservation {
            descriptor: stale_descriptor,
            health: SessionHealth::StaleTransport,
        });

        let report = serde_json::to_value(summarize(
            BuildIdentity {
                package_version: "0.1.4",
                build_id: "cli-build",
                capabilities: CAPABILITIES,
            },
            1_000,
            Duration::from_millis(125),
            observations,
            registration_capacity(),
            resource(1_000),
        ))
        .unwrap();

        assert_eq!(report["status"], "degraded");
        assert_eq!(report["sessionHosts"]["state"], "stale");
        assert_eq!(report["sessionHosts"]["stale"], 1);
        assert_eq!(report["sessionHosts"]["healthy"], SESSION_HOST_SAMPLE_LIMIT);
        assert_eq!(report["sessionHostSample"].as_array().unwrap().len(), 16);
        assert_eq!(report["sessionHostSample"][0]["sessionId"], "z-stale");
        assert_eq!(report["sessionHostSampleHasMore"], true);
        assert_eq!(report["sessionHostSampleOmittedCount"], 1);
    }

    #[test]
    fn build_skew_counts_only_active_ready_hosts() {
        let mut ready = descriptor(&[SCREEN_SNAPSHOT_PROFILE_CAPABILITY]);
        ready.session_id = "ready".into();
        ready.host_build_version = "active-build".into();
        let mut exited = descriptor(&[SCREEN_SNAPSHOT_PROFILE_CAPABILITY]);
        exited.session_id = "exited".into();
        exited.lifecycle = SessionLifecycle::Exited;
        exited.host_build_version = "historical-build".into();
        let report = serde_json::to_value(summarize(
            BuildIdentity {
                package_version: "0.1.4",
                build_id: "cli-build",
                capabilities: CAPABILITIES,
            },
            1_000,
            Duration::from_millis(125),
            vec![
                SessionObservation {
                    descriptor: ready,
                    health: SessionHealth::Healthy,
                },
                SessionObservation {
                    descriptor: exited,
                    health: SessionHealth::Exited,
                },
            ],
            registration_capacity(),
            resource(1_000),
        ))
        .unwrap();

        assert_eq!(report["sessionHosts"]["buildCountBasis"], "active_ready");
        assert_eq!(
            report["sessionHosts"]["buildCounts"],
            serde_json::json!({"active-build": 1})
        );
        assert_eq!(report["sessionHosts"]["buildSkew"], false);
    }
}
