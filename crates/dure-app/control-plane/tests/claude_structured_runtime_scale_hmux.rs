#![cfg(unix)]

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use dure_app::{
    AgentExecutionProfileV1, AgentIdV1, AgentProviderRuntimeFenceV1, AgentRecordV1, DomainStore,
    ProjectIdV1, ProjectRecordV1, ProviderIdV1, ProviderPermissionModeV1, WorkspaceIdV1,
    WorkspaceRecordV1,
};
use dure_app_sqlite::SqliteDomainStore;
use dure_control_plane::agent_conversation::AgentConversationService;
use dure_control_plane::agent_conversation_api::AgentConversationRuntimeRegistry;
use dure_control_plane::claude_conversation_host::ClaudeConversationHost;
use dure_control_plane::claude_sdk_host_supervisor::ClaudeSdkHostSupervisorConfiguration;
use dure_control_plane::claude_structured_runtime::{
    ClaudeStructuredOpenRequestV1, ClaudeStructuredRuntimeConfiguration,
    ClaudeStructuredRuntimeManager,
};
use dure_control_plane::provider_credential_profile::ProviderCredentialProfileRegistry;
use hmux_client::{
    LocalProcessGenerationStatus, LocalSessionCatalog, SessionDescriptor,
    probe_local_process_generation,
};
use serde::{Deserialize, Serialize};

#[path = "support/process_metrics.rs"]
mod process_metrics;

use process_metrics::{
    HardwareContext, RoleMeasurement, descendant_pids, duration_millis, hardware_context,
    measure_roles, percentile, process_memory_method, process_rows, role_processes,
    sample_processes, sum_optional, wait_for_process_absence,
};

const COUNTS: [usize; 3] = [1, 5, 20];
const SETTLE_WINDOW: Duration = Duration::from_secs(1);
const IDLE_WINDOW: Duration = Duration::from_secs(3);
const PROCESS_WAIT: Duration = Duration::from_secs(10);

#[derive(Clone)]
struct FixturePaths {
    account_config: Option<PathBuf>,
    database: PathBuf,
    discovery_root: PathBuf,
    driver: PathBuf,
    entrypoint: PathBuf,
    hmux_runtime: PathBuf,
    host_state_root: PathBuf,
    node: PathBuf,
    relay: PathBuf,
    relay_state_root: PathBuf,
    root: PathBuf,
    runtime_root: PathBuf,
}

#[derive(Clone, Debug)]
struct BindingIdentity {
    agent_id: String,
    interaction_session_id: String,
    runtime: AgentProviderRuntimeFenceV1,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PhaseTotals {
    process_count: usize,
    rss_kib: u64,
    physical_footprint_kib: Option<u64>,
    fd_count: Option<u64>,
    socket_count: Option<u64>,
    idle_cpu_nanos: Option<u64>,
    idle_interrupt_wakeups: Option<u64>,
    idle_package_wakeups: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PhaseMeasurement {
    backend_generation: String,
    open_wall_ms: f64,
    open_p50_ms: f64,
    open_p95_ms: f64,
    totals: PhaseTotals,
    roles: Vec<RoleMeasurement>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReplacementMeasurement {
    interaction_count: usize,
    preserved_interaction_count: usize,
    rotated_runtime_fence_count: usize,
    old_exact_generation_count: usize,
    old_exact_generations_retired_before_final_cleanup: bool,
    shared_host_replaced: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScenarioMeasurement {
    count: usize,
    initial: PhaseMeasurement,
    replacement: PhaseMeasurement,
    backend_replacement: ReplacementMeasurement,
    cleanup_remaining_process_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MeasurementMethod {
    process_memory: &'static str,
    settle_window_ms: u64,
    idle_window_ms: u64,
    startup_policy: &'static str,
    replacement_policy: &'static str,
    cleanup_policy: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScaleReport {
    schema_version: u16,
    provider: &'static str,
    provider_mode: &'static str,
    runtime_artifact: RuntimeArtifactMeasurement,
    hardware: HardwareContext,
    method: MeasurementMethod,
    scenarios: Vec<ScenarioMeasurement>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeArtifactMeasurement {
    claude_code_version: String,
    executable_sha256: String,
    sdk_version: String,
    target: String,
}

struct PhaseOutcome {
    bindings: Vec<BindingIdentity>,
    descriptors: Vec<SessionDescriptor>,
    host_pid: u32,
    measurement: PhaseMeasurement,
    owned_pids: BTreeSet<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostMarker {
    role: String,
    pid: u32,
    host_generation: String,
}

fn required_executable(name: &str) -> PathBuf {
    let path = PathBuf::from(
        std::env::var_os(name).unwrap_or_else(|| panic!("{name} is required for this QA test")),
    )
    .canonicalize()
    .unwrap();
    assert!(path.is_file(), "{name} is not a file");
    path
}

fn exact_directory_from_env(name: &str) -> PathBuf {
    let path = PathBuf::from(
        std::env::var_os(name).unwrap_or_else(|| panic!("{name} is required for this QA test")),
    )
    .canonicalize()
    .unwrap();
    assert!(path.is_dir(), "{name} is not a directory");
    path
}

fn owner_directory(path: &Path) {
    fs::create_dir(path).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}

fn install_runtime(paths: &FixturePaths, source: &Path) -> RuntimeArtifactMeasurement {
    let installer = paths
        .driver
        .join("claude-runtime-install.mjs")
        .canonicalize()
        .unwrap();
    let output = Command::new(&paths.node)
        .args([
            installer.as_os_str(),
            "--runtime-root".as_ref(),
            paths.runtime_root.as_os_str(),
            "--source".as_ref(),
            source.as_os_str(),
        ])
        .current_dir(&paths.driver)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "Claude runtime adoption failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

async fn seed(store: &SqliteDomainStore, root: &Path, count: usize) {
    store
        .upsert_project(&ProjectRecordV1 {
            project_id: ProjectIdV1::new("project-claude-runtime-scale").unwrap(),
            root_path: root.to_string_lossy().into_owned(),
            display_name: "Claude runtime scale".into(),
            created_at_ms: 1,
            updated_at_ms: 1,
        })
        .await
        .unwrap();
    for index in 0..count {
        let workspace = root.join(format!("workspace-{index}"));
        fs::create_dir_all(&workspace).unwrap();
        let workspace_id = WorkspaceIdV1::new(format!("workspace-claude-scale-{index}")).unwrap();
        store
            .upsert_workspace(&WorkspaceRecordV1 {
                workspace_id: workspace_id.clone(),
                project_id: ProjectIdV1::new("project-claude-runtime-scale").unwrap(),
                root_path: workspace.to_string_lossy().into_owned(),
                base_commit_sha: None,
                created_at_ms: 2,
                updated_at_ms: 2,
            })
            .await
            .unwrap();
        store
            .upsert_agent(&AgentRecordV1 {
                agent_id: AgentIdV1::new(format!("agent-claude-scale-{index}")).unwrap(),
                workspace_id,
                provider_id: ProviderIdV1::new("claude").unwrap(),
                display_name: format!("Claude runtime scale {index}"),
                created_at_ms: 3,
                updated_at_ms: 3,
            })
            .await
            .unwrap();
    }
}

fn live_descriptors(discovery_root: &Path, count: usize) -> Vec<SessionDescriptor> {
    let mut descriptors = LocalSessionCatalog::new(discovery_root)
        .list()
        .unwrap()
        .into_iter()
        .filter(|descriptor| {
            descriptor.provider_id == "claude"
                && probe_local_process_generation(&descriptor.host_process).unwrap()
                    == LocalProcessGenerationStatus::Live
                && probe_local_process_generation(&descriptor.provider_process).unwrap()
                    == LocalProcessGenerationStatus::Live
        })
        .collect::<Vec<_>>();
    descriptors.sort_by(|left, right| left.workspace_id.cmp(&right.workspace_id));
    assert_eq!(descriptors.len(), count, "unexpected live Claude topology");
    descriptors
}

fn host_marker(state_root: &Path, expected_generation: &str) -> HostMarker {
    let mut markers = fs::read_dir(state_root)
        .unwrap()
        .flatten()
        .filter_map(|entry| fs::read(entry.path().join("host.json")).ok())
        .filter_map(|source| serde_json::from_slice::<HostMarker>(&source).ok())
        .filter(|marker| marker.host_generation == expected_generation)
        .collect::<Vec<_>>();
    assert_eq!(markers.len(), 1, "expected one shared Claude SDK host");
    let marker = markers.remove(0);
    assert_eq!(marker.role, "dure-claude-sdk-host");
    marker
}

fn claude_roles(
    descriptors: &[SessionDescriptor],
    host_pid: u32,
) -> BTreeMap<String, BTreeSet<u32>> {
    let rows = process_rows();
    let row_pids = rows.iter().map(|row| row.pid).collect::<BTreeSet<_>>();
    assert!(row_pids.contains(&host_pid), "shared SDK host disappeared");
    let mut roles = BTreeMap::from([("shared_node_sdk_host".into(), BTreeSet::from([host_pid]))]);
    let mut hmux_hosts = BTreeSet::new();
    let mut relays = BTreeSet::new();
    let mut provider_roots = BTreeSet::new();
    let mut provider_descendants = BTreeSet::new();
    let mut complete_hmux_trees = BTreeSet::new();
    for descriptor in descriptors {
        let hmux_pid = descriptor.host_process.process_id;
        let relay_pid = descriptor.provider_process.process_id;
        assert!(row_pids.contains(&hmux_pid), "Hmux host disappeared");
        assert!(row_pids.contains(&relay_pid), "native relay disappeared");
        let hmux_descendants = descendant_pids(&rows, hmux_pid);
        assert!(
            hmux_descendants.contains(&relay_pid),
            "Hmux host does not own its exact relay"
        );
        let direct_provider_children = rows
            .iter()
            .filter(|row| row.parent_pid == relay_pid)
            .map(|row| row.pid)
            .collect::<Vec<_>>();
        assert_eq!(
            direct_provider_children.len(),
            1,
            "initialized Claude Query must retain one direct CLI root"
        );
        let provider_pid = direct_provider_children[0];
        hmux_hosts.insert(hmux_pid);
        relays.insert(relay_pid);
        provider_roots.insert(provider_pid);
        provider_descendants.extend(descendant_pids(&rows, provider_pid));
        complete_hmux_trees.insert(hmux_pid);
        complete_hmux_trees.extend(hmux_descendants);
    }
    roles.insert("hmux_host".into(), hmux_hosts);
    roles.insert("native_relay".into(), relays);
    roles.insert("claude_cli".into(), provider_roots);
    if !provider_descendants.is_empty() {
        roles.insert("claude_descendant".into(), provider_descendants);
    }
    let owned = role_processes(&roles);
    let mut expected = complete_hmux_trees;
    expected.insert(host_pid);
    assert_eq!(
        owned, expected,
        "Claude process roles must partition ownership"
    );
    owned.iter().for_each(|pid| {
        assert!(
            rows.iter().any(|row| row.pid == *pid && row.rss_kib > 0),
            "owned process RSS must be observable"
        )
    });
    roles
}

fn phase_totals(roles: &[RoleMeasurement]) -> PhaseTotals {
    PhaseTotals {
        process_count: roles.iter().map(|role| role.process_count).sum(),
        rss_kib: roles.iter().map(|role| role.rss_kib).sum(),
        physical_footprint_kib: sum_optional(roles.iter().map(|role| role.physical_footprint_kib)),
        fd_count: sum_optional(roles.iter().map(|role| role.fd_count)),
        socket_count: sum_optional(roles.iter().map(|role| role.socket_count)),
        idle_cpu_nanos: sum_optional(roles.iter().map(|role| role.idle_cpu_nanos)),
        idle_interrupt_wakeups: sum_optional(roles.iter().map(|role| role.idle_interrupt_wakeups)),
        idle_package_wakeups: sum_optional(roles.iter().map(|role| role.idle_package_wakeups)),
    }
}

fn assert_stable_role(roles: &[RoleMeasurement], role: &str, expected_count: usize) {
    let measurement = roles
        .iter()
        .find(|measurement| measurement.role == role)
        .unwrap_or_else(|| panic!("missing {role} measurement"));
    assert_eq!(measurement.process_count, expected_count);
    assert_eq!(measurement.stable_process_count, expected_count);
    assert_eq!(measurement.started_during_idle_count, 0);
    assert_eq!(measurement.exited_during_idle_count, 0);
}

fn wait_for_descriptor_absence(descriptors: &[SessionDescriptor]) {
    let deadline = Instant::now() + PROCESS_WAIT;
    for descriptor in descriptors {
        loop {
            let host = probe_local_process_generation(&descriptor.host_process).unwrap();
            let provider = probe_local_process_generation(&descriptor.provider_process).unwrap();
            if host == LocalProcessGenerationStatus::Absent
                && provider == LocalProcessGenerationStatus::Absent
            {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "old exact Claude generation survived backend replacement"
            );
            thread::sleep(Duration::from_millis(20));
        }
    }
}

async fn run_phase(
    paths: FixturePaths,
    backend_generation: String,
    count: usize,
    prior_descriptors: Vec<SessionDescriptor>,
    stop_after_measurement: bool,
) -> PhaseOutcome {
    let store = Arc::new(SqliteDomainStore::open(&paths.database).await.unwrap());
    seed(&store, &paths.root, count).await;
    let service = Arc::new(AgentConversationService::new(Arc::clone(&store)));
    let registry = Arc::new(AgentConversationRuntimeRegistry::default());
    let host_generation = format!("host-{backend_generation}");
    let host_environment = vec![
        ("HOME".into(), paths.root.to_string_lossy().into_owned()),
        ("PATH".into(), std::env::var("PATH").unwrap_or_default()),
    ];
    let host_configuration = ClaudeSdkHostSupervisorConfiguration::new(
        paths.node.clone(),
        paths.entrypoint.clone(),
        paths.host_state_root.clone(),
        paths.runtime_root.clone(),
        host_generation.clone(),
        host_environment,
    )
    .unwrap();
    let host = Arc::new(
        ClaudeConversationHost::new(
            host_configuration,
            format!("client-{backend_generation}"),
            Arc::clone(&service),
            Arc::clone(&registry),
        )
        .unwrap(),
    );
    let credential_profiles = Arc::new(ProviderCredentialProfileRegistry::new(
        paths.root.clone(),
        Arc::clone(&store),
    ));
    let mut environment = BTreeMap::from([
        ("HOME".into(), paths.root.to_string_lossy().into_owned()),
        ("PATH".into(), std::env::var("PATH").unwrap_or_default()),
    ]);
    if let Some(account_config) = &paths.account_config {
        environment.insert(
            "CLAUDE_CONFIG_DIR".into(),
            account_config.to_string_lossy().into_owned(),
        );
    }
    let configuration = ClaudeStructuredRuntimeConfiguration::new(
        backend_generation.clone(),
        paths.hmux_runtime.clone(),
        paths.discovery_root.clone(),
        paths.relay.clone(),
        paths.relay_state_root.clone(),
        environment,
    )
    .unwrap();
    let manager = ClaudeStructuredRuntimeManager::new(
        configuration,
        credential_profiles,
        Arc::clone(&service),
        Arc::clone(&host),
        Arc::clone(&store),
    );

    let wall_started = Instant::now();
    let mut open_durations = Vec::with_capacity(count);
    let mut receipts = Vec::with_capacity(count);
    for index in 0..count {
        let started = Instant::now();
        let receipt = manager
            .open(ClaudeStructuredOpenRequestV1 {
                agent_id: AgentIdV1::new(format!("agent-claude-scale-{index}")).unwrap(),
                execution_profile: AgentExecutionProfileV1::ProviderDefault,
                provider_conversation_ref: None,
                permission_mode: ProviderPermissionModeV1::Default,
                model: None,
                effort: None,
            })
            .await
            .unwrap();
        open_durations.push(duration_millis(started.elapsed()));
        receipts.push(receipt);
    }
    let open_wall_ms = duration_millis(wall_started.elapsed());
    assert_eq!(host.host_launch_count().unwrap(), 1);
    assert_eq!(host.client_attach_count(), 1);
    if !prior_descriptors.is_empty() {
        wait_for_descriptor_absence(&prior_descriptors);
    }
    let descriptors = live_descriptors(&paths.discovery_root, count);
    let marker = host_marker(&paths.host_state_root, &host_generation);
    thread::sleep(SETTLE_WINDOW);
    let before_roles = claude_roles(&descriptors, marker.pid);
    let before_pids = role_processes(&before_roles);
    let before = sample_processes(&before_pids);
    thread::sleep(IDLE_WINDOW);
    let after_roles = claude_roles(&descriptors, marker.pid);
    let after_pids = role_processes(&after_roles);
    let after = sample_processes(&after_pids);
    let roles = measure_roles(&before_roles, &after_roles, &before, &after);
    assert_stable_role(&roles, "shared_node_sdk_host", 1);
    assert_stable_role(&roles, "hmux_host", count);
    assert_stable_role(&roles, "native_relay", count);
    assert_stable_role(&roles, "claude_cli", count);
    let owned_pids = before_pids.union(&after_pids).copied().collect();
    let totals = phase_totals(&roles);
    let bindings = receipts
        .iter()
        .map(|receipt| BindingIdentity {
            agent_id: receipt.binding.agent_id.as_str().into(),
            interaction_session_id: receipt.binding.interaction_session_id.as_str().into(),
            runtime: receipt.binding.runtime.clone(),
        })
        .collect::<Vec<_>>();
    let measurement = PhaseMeasurement {
        backend_generation,
        open_wall_ms,
        open_p50_ms: percentile(&open_durations, 0.50),
        open_p95_ms: percentile(&open_durations, 0.95),
        totals,
        roles,
    };
    if stop_after_measurement {
        for receipt in &receipts {
            assert!(
                manager
                    .stop(
                        &receipt.binding.interaction_session_id,
                        &receipt.binding.runtime.runtime_generation,
                    )
                    .await
                    .unwrap()
            );
        }
        wait_for_descriptor_absence(&descriptors);
    }
    PhaseOutcome {
        bindings,
        descriptors,
        host_pid: marker.pid,
        measurement,
        owned_pids,
    }
}

fn execute_phase(
    paths: FixturePaths,
    backend_generation: String,
    count: usize,
    prior_descriptors: Vec<SessionDescriptor>,
    stop_after_measurement: bool,
) -> PhaseOutcome {
    thread::spawn(move || {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap()
            .block_on(run_phase(
                paths,
                backend_generation,
                count,
                prior_descriptors,
                stop_after_measurement,
            ))
    })
    .join()
    .unwrap()
}

fn replacement_measurement(
    initial: &PhaseOutcome,
    replacement: &PhaseOutcome,
) -> ReplacementMeasurement {
    let initial_by_agent = initial
        .bindings
        .iter()
        .map(|binding| (binding.agent_id.as_str(), binding))
        .collect::<BTreeMap<_, _>>();
    let preserved_interaction_count = replacement
        .bindings
        .iter()
        .filter(|binding| {
            initial_by_agent
                .get(binding.agent_id.as_str())
                .is_some_and(|initial| {
                    initial.interaction_session_id == binding.interaction_session_id
                })
        })
        .count();
    let rotated_runtime_fence_count = replacement
        .bindings
        .iter()
        .filter(|binding| {
            initial_by_agent
                .get(binding.agent_id.as_str())
                .is_some_and(|initial| initial.runtime != binding.runtime)
        })
        .count();
    ReplacementMeasurement {
        interaction_count: initial.bindings.len(),
        preserved_interaction_count,
        rotated_runtime_fence_count,
        old_exact_generation_count: initial.descriptors.len(),
        old_exact_generations_retired_before_final_cleanup: true,
        shared_host_replaced: initial.host_pid != replacement.host_pid,
    }
}

#[test]
#[ignore = "capacity QA; requires Hmux, Node, installed driver dependencies, and optional real Claude credentials"]
fn initialized_claude_runtime_matrix_1_5_20_replaces_backend_and_cleans_exactly() {
    let node = required_executable("DURE_NODE_BIN");
    let hmux_runtime = required_executable("DURE_HMUX_RUNTIME_BIN");
    let relay = PathBuf::from(env!("CARGO_BIN_EXE_dure-claude-process-relay"))
        .canonicalize()
        .unwrap();
    let manifest_root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let driver = manifest_root.join("provider-drivers/claude");
    let entrypoint = driver
        .join("shared-sdk-host-entrypoint.mjs")
        .canonicalize()
        .unwrap();
    let fake_claude = manifest_root
        .join("tests/fixtures/fake-claude-agent-sdk-cli.mjs")
        .canonicalize()
        .unwrap();
    let source = std::env::var_os("DURE_SCALE_CLAUDE_RUNTIME_SOURCE")
        .map(PathBuf::from)
        .map(|path| path.canonicalize().unwrap())
        .unwrap_or(fake_claude);
    let provider_mode = if std::env::var_os("DURE_SCALE_CLAUDE_RUNTIME_SOURCE").is_some() {
        "real"
    } else {
        "deterministic_fake"
    };
    let account_config = std::env::var_os("DURE_SCALE_CLAUDE_CONFIG_DIR")
        .map(|_| exact_directory_from_env("DURE_SCALE_CLAUDE_CONFIG_DIR"));
    if provider_mode == "real" {
        assert!(
            account_config.is_some(),
            "real Claude capacity QA requires an explicit credential profile directory"
        );
    }

    let temporary = tempfile::Builder::new()
        .prefix("dcs-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let root = temporary.path().to_path_buf();
    let discovery_root = root.join("discovery");
    let host_state_root = root.join("host");
    let relay_state_root = root.join("relays");
    for directory in [&discovery_root, &host_state_root, &relay_state_root] {
        owner_directory(directory);
    }
    let paths = FixturePaths {
        account_config,
        database: root.join("domain.sqlite3"),
        discovery_root,
        driver,
        entrypoint,
        hmux_runtime,
        host_state_root,
        node,
        relay,
        relay_state_root,
        root: root.clone(),
        runtime_root: root.join("runtime"),
    };
    let runtime_artifact = install_runtime(&paths, &source);
    let mut scenarios = Vec::new();
    for count in COUNTS {
        let scenario_root = root.join(format!("scenario-{count}"));
        owner_directory(&scenario_root);
        let scenario_paths = FixturePaths {
            database: scenario_root.join("domain.sqlite3"),
            discovery_root: scenario_root.join("discovery"),
            host_state_root: scenario_root.join("host"),
            relay_state_root: scenario_root.join("relays"),
            root: scenario_root,
            ..paths.clone()
        };
        for directory in [
            &scenario_paths.discovery_root,
            &scenario_paths.host_state_root,
            &scenario_paths.relay_state_root,
        ] {
            owner_directory(directory);
        }
        let initial = execute_phase(
            scenario_paths.clone(),
            format!("claude-scale-{count}-initial"),
            count,
            Vec::new(),
            false,
        );
        wait_for_process_absence(&BTreeSet::from([initial.host_pid]), PROCESS_WAIT);
        let replacement = execute_phase(
            scenario_paths,
            format!("claude-scale-{count}-replacement"),
            count,
            initial.descriptors.clone(),
            true,
        );
        let backend_replacement = replacement_measurement(&initial, &replacement);
        assert_eq!(backend_replacement.preserved_interaction_count, count);
        assert_eq!(backend_replacement.rotated_runtime_fence_count, count);
        assert!(backend_replacement.shared_host_replaced);
        let all_owned = initial
            .owned_pids
            .union(&replacement.owned_pids)
            .copied()
            .collect::<BTreeSet<_>>();
        wait_for_process_absence(&all_owned, PROCESS_WAIT);
        scenarios.push(ScenarioMeasurement {
            count,
            initial: initial.measurement,
            replacement: replacement.measurement,
            backend_replacement,
            cleanup_remaining_process_count: 0,
        });
    }
    let report = ScaleReport {
        schema_version: 1,
        provider: "claude",
        provider_mode,
        runtime_artifact,
        hardware: hardware_context(),
        method: MeasurementMethod {
            process_memory: process_memory_method(),
            settle_window_ms: SETTLE_WINDOW.as_millis() as u64,
            idle_window_ms: IDLE_WINDOW.as_millis() as u64,
            startup_policy: "serial structured opens; every initialized Query remains live for the simultaneous sample",
            replacement_policy: "drop one complete backend Tokio runtime, then recover every durable interaction through a new backend generation",
            cleanup_policy: "provider manager exact-stop receipts followed by numeric absence of every observed QA PID",
        },
        scenarios,
    };
    println!(
        "structured_chat_runtime_scale={}",
        serde_json::to_string(&report).unwrap()
    );
}
