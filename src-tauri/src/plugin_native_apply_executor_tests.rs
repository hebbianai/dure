use super::*;
use dure_app::{
    AgentAdapterIdV2, AgentInstallScopeV2, AgentIntegrationIdV2, AgentNativeMarketplaceNameV2,
    AgentNativePluginCliOutputV2, AgentNativePluginExecutableV2, AgentNativePluginNameV2,
    AgentNativePluginRegistrationTargetV2, AgentNativePluginSelectorV2, PhysicalTargetKeyV2,
    PluginApplyJournalStateV2, PluginApplyOperationKindV2, PluginIdV2, PluginResourcePathV2,
    PluginVersionV2,
};
use dure_app_sqlite::SqliteDomainStore;
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Connection, SqliteConnection};
use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tempfile::TempDir;

const ORPHAN_EXECUTOR_ROOT: &str = "DURE_TEST_PLUGIN_NATIVE_ORPHAN_EXECUTOR_ROOT";

struct CompensationFaultStore {
    inner: SqliteDomainStore,
    fail_child_start: AtomicBool,
    fail_parent_completion: AtomicBool,
}

impl PluginApplyJournalStore for CompensationFaultStore {
    fn append_plugin_apply_event<'a>(
        &'a self,
        event: &'a PluginApplyJournalEventV2,
    ) -> dure_app::DomainStoreFuture<'a, PluginApplyJournalReceiptV2> {
        if matches!(
            &event.body,
            PluginApplyJournalEventBodyV2::Started {
                compensation_for: Some(_),
                ..
            }
        ) && self.fail_child_start.swap(false, Ordering::SeqCst)
        {
            return Box::pin(async {
                Err(DomainStoreErrorV1::Storage {
                    code: "injected_compensation_child_start",
                    detail: "fault injected after the parent link was durable".into(),
                })
            });
        }
        if matches!(
            &event.body,
            PluginApplyJournalEventBodyV2::Compensated { .. }
        ) && self.fail_parent_completion.swap(false, Ordering::SeqCst)
        {
            return Box::pin(async {
                Err(DomainStoreErrorV1::Storage {
                    code: "injected_compensation_parent_completion",
                    detail: "fault injected after the child success was durable".into(),
                })
            });
        }
        self.inner.append_plugin_apply_event(event)
    }

    fn plugin_apply_receipt<'a>(
        &'a self,
        operation_id: &'a OperationIdV1,
    ) -> dure_app::DomainStoreFuture<'a, Option<PluginApplyJournalReceiptV2>> {
        self.inner.plugin_apply_receipt(operation_id)
    }

    fn plugin_native_ownership<'a>(
        &'a self,
        ownership_key: &'a dure_app::PluginNativeOwnershipKeyV2,
    ) -> dure_app::DomainStoreFuture<'a, Option<dure_app::PluginNativeOwnershipReceiptV2>> {
        self.inner.plugin_native_ownership(ownership_key)
    }

    fn rebuild_plugin_apply_receipts(&self) -> dure_app::DomainStoreFuture<'_, usize> {
        self.inner.rebuild_plugin_apply_receipts()
    }

    fn rebuild_plugin_native_ownership(&self) -> dure_app::DomainStoreFuture<'_, usize> {
        self.inner.rebuild_plugin_native_ownership()
    }
}

impl PluginNativeApplyAuthorityStore for CompensationFaultStore {
    fn validate_plugin_native_target_bindings<'a>(
        &'a self,
        operation_id: &'a OperationIdV1,
        bindings: &'a [dure_app::PluginNativePhysicalTargetBindingV2],
    ) -> dure_app::DomainStoreFuture<'a, ()> {
        self.inner
            .validate_plugin_native_target_bindings(operation_id, bindings)
    }

    fn rebuild_plugin_native_target_bindings(&self) -> dure_app::DomainStoreFuture<'_, usize> {
        self.inner.rebuild_plugin_native_target_bindings()
    }
}

struct Fixture {
    _temp: TempDir,
    executable: PathBuf,
    package: PathBuf,
    neutral: PathBuf,
    profile: PathBuf,
    profile_key: PhysicalTargetKeyV2,
    targets: BTreeMap<PhysicalTargetKeyV2, PathBuf>,
    version: PluginVersionV2,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let executable = temp.path().join("codex");
        let package = temp.path().join("package");
        let neutral = temp.path().join("neutral");
        let profile = temp.path().join("profile");
        fs::create_dir_all(package.join("agents/codex")).unwrap();
        fs::create_dir(&neutral).unwrap();
        fs::create_dir(&profile).unwrap();
        fs::write(
            &executable,
            br#"#!/bin/sh
set -eu
marketplace_file="$CODEX_HOME/marketplace"
installed_file="$CODEX_HOME/installed"
executed_file="$CODEX_HOME/executed"
mutations_file="$CODEX_HOME/mutations"
fail_install_file="$CODEX_HOME/fail-install"
invocations_file="$CODEX_HOME/invocations"
printf '%s\n' "$*" >> "$invocations_file"
if [ "$1" = "plugin" ] && [ "$2" = "marketplace" ] && [ "$3" = "list" ]; then
  if [ -f "$marketplace_file" ]; then
source_path=$(sed -n '1p' "$marketplace_file")
printf '{"marketplaces":[{"name":"dure-bundled","marketplaceSource":{"sourceType":"local","source":"%s"}}]}' "$source_path"
  else
printf '{"marketplaces":[]}'
  fi
elif [ "$1" = "plugin" ] && [ "$2" = "marketplace" ] && [ "$3" = "add" ]; then
  if [ -f "$CODEX_HOME/block-mutation" ]; then
touch "$CODEX_HOME/mutation-entered"
while [ ! -f "$CODEX_HOME/release-mutation" ]; do sleep 0.01; done
  fi
  printf '%s\n' "$4" > "$marketplace_file"
  printf 'marketplace\n' >> "$mutations_file"
  printf '{}'
elif [ "$1" = "plugin" ] && [ "$2" = "marketplace" ] && [ "$3" = "remove" ]; then
  touch "$executed_file"
  rm -f "$marketplace_file"
  printf '{}'
elif [ "$1" = "plugin" ] && [ "$2" = "list" ]; then
  if [ -f "$installed_file" ]; then
printf '{"installed":[{"pluginId":"dure-beads@dure-bundled","version":"1.0.0","installed":true,"enabled":true}]}'
  else
printf '{"installed":[]}'
  fi
elif [ "$1" = "plugin" ] && [ "$2" = "add" ]; then
  if [ -f "$fail_install_file" ]; then
rm -f "$fail_install_file"
rm -f "$marketplace_file"
exit 7
  fi
  touch "$installed_file"
  printf 'plugin\n' >> "$mutations_file"
  printf '{}'
elif [ "$1" = "plugin" ] && [ "$2" = "remove" ]; then
  touch "$executed_file"
  rm -f "$installed_file"
  printf '{}'
else
  exit 64
fi
"#,
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let profile_key = PhysicalTargetKeyV2::new("codex.profile.test").unwrap();
        let targets = BTreeMap::from([(profile_key.clone(), profile.clone())]);
        Self {
            _temp: temp,
            executable,
            package,
            neutral,
            profile,
            profile_key,
            targets,
            version: PluginVersionV2::new("1.0.0").unwrap(),
        }
    }

    fn host(&self) -> PluginNativeCliHostContext<'_> {
        PluginNativeCliHostContext {
            executable: AgentNativePluginExecutableV2::Codex,
            executable_path: &self.executable,
            executable_version: &self.version,
            package_root: &self.package,
            neutral_working_directory: &self.neutral,
            physical_targets: &self.targets,
        }
    }

    fn marketplace_source(&self) -> AgentNativePluginMarketplaceSourceV2 {
        AgentNativePluginMarketplaceSourceV2 {
            resource: PluginResourcePathV2::new("./agents/codex").unwrap(),
        }
    }

    fn store_path(&self) -> PathBuf {
        self._temp.path().join("domain.sqlite")
    }
}

fn selector() -> AgentNativePluginSelectorV2 {
    AgentNativePluginSelectorV2 {
        plugin: AgentNativePluginNameV2::new("dure-beads").unwrap(),
        marketplace: AgentNativeMarketplaceNameV2::new("dure-bundled").unwrap(),
    }
}

fn step(fixture: &Fixture, command: AgentNativePluginCliCommandV2) -> PluginApplyStepV2 {
    step_for(&fixture.profile_key, &fixture.version, command)
}

fn step_for(
    profile_key: &PhysicalTargetKeyV2,
    version: &PluginVersionV2,
    command: AgentNativePluginCliCommandV2,
) -> PluginApplyStepV2 {
    PluginApplyStepV2 {
        integration_id: AgentIntegrationIdV2::new("dure.beads.codex").unwrap(),
        adapter: AgentAdapterIdV2::new("codex").unwrap(),
        executable: AgentNativePluginExecutableV2::Codex,
        cli_version: version.clone(),
        selector: selector(),
        registration_target: AgentNativePluginRegistrationTargetV2::ManagedProfile {
            profile_root_key: profile_key.clone(),
        },
        command,
    }
}

fn started_event(
    fixture: &Fixture,
    operation_id: &OperationIdV1,
    operation_kind: PluginApplyOperationKindV2,
    steps: Vec<PluginApplyStepV2>,
) -> PluginApplyJournalEventV2 {
    let host = fixture.host();
    let leases =
        resolve_plugin_native_target_leases(&steps, &host, &target_binding_authority(fixture))
            .unwrap();
    PluginApplyJournalEventV2 {
        event_id: OperationEventIdV1::new(format!("{}-started", operation_id.as_str())).unwrap(),
        operation_id: operation_id.clone(),
        sequence: 1,
        body: PluginApplyJournalEventBodyV2::Started {
            idempotency_key: format!("{}-request", operation_id.as_str()),
            plugin_id: PluginIdV2::new("dure.beads").unwrap(),
            plugin_version: PluginVersionV2::new("1.0.0").unwrap(),
            compensation_for: None,
            target_bindings: Some(leases.bindings().to_vec()),
            operation_kind,
            steps,
        },
        recorded_at_ms: 1,
    }
}

fn target_binding_authority(fixture: &Fixture) -> PluginNativeTargetBindingAuthority {
    PluginNativeTargetBindingAuthority::open_or_create(fixture._temp.path()).unwrap()
}

fn install_steps(fixture: &Fixture) -> Vec<PluginApplyStepV2> {
    vec![
        step(
            fixture,
            AgentNativePluginCliCommandV2::AddMarketplace {
                source: fixture.marketplace_source(),
                scope: AgentInstallScopeV2::Managed,
                output: AgentNativePluginCliOutputV2::Json,
            },
        ),
        step(
            fixture,
            AgentNativePluginCliCommandV2::InstallPlugin {
                selector: selector(),
                scope: AgentInstallScopeV2::Managed,
                output: AgentNativePluginCliOutputV2::Json,
            },
        ),
    ]
}

fn remove_step(fixture: &Fixture) -> PluginApplyStepV2 {
    step(
        fixture,
        AgentNativePluginCliCommandV2::RemovePlugin {
            selector: selector(),
            scope: AgentInstallScopeV2::Managed,
            preserve_data: true,
            output: AgentNativePluginCliOutputV2::Json,
        },
    )
}

fn uninstall_steps(fixture: &Fixture) -> Vec<PluginApplyStepV2> {
    vec![
        remove_step(fixture),
        step(
            fixture,
            AgentNativePluginCliCommandV2::RemoveMarketplace {
                marketplace: selector().marketplace,
                scope: AgentInstallScopeV2::Managed,
                output: AgentNativePluginCliOutputV2::Json,
            },
        ),
    ]
}

async fn open_store(fixture: &Fixture) -> SqliteDomainStore {
    SqliteDomainStore::open(fixture.store_path()).await.unwrap()
}

fn wait_for_file(path: &std::path::Path) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !path.exists() {
        assert!(
            Instant::now() < deadline,
            "timed out waiting for {}",
            path.display()
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

struct MutationRelease(PathBuf);

impl MutationRelease {
    fn release(&self) {
        fs::write(&self.0, b"release").unwrap();
    }
}

impl Drop for MutationRelease {
    fn drop(&mut self) {
        let _ = fs::write(&self.0, b"release");
    }
}

struct OwnedExecutorParent(Child);

impl Drop for OwnedExecutorParent {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn orphan_executor_parent_helper() {
    let Some(root) = std::env::var_os(ORPHAN_EXECUTOR_ROOT) else {
        return;
    };
    let root = PathBuf::from(root);
    let executable = root.join("codex");
    let package = root.join("package");
    let neutral = root.join("neutral");
    let profile = root.join("profile");
    let profile_key = PhysicalTargetKeyV2::new("codex.profile.test").unwrap();
    let targets = BTreeMap::from([(profile_key.clone(), profile)]);
    let version = PluginVersionV2::new("1.0.0").unwrap();
    let host = PluginNativeCliHostContext {
        executable: AgentNativePluginExecutableV2::Codex,
        executable_path: &executable,
        executable_version: &version,
        package_root: &package,
        neutral_working_directory: &neutral,
        physical_targets: &targets,
    };
    let source = AgentNativePluginMarketplaceSourceV2 {
        resource: PluginResourcePathV2::new("./agents/codex").unwrap(),
    };
    let steps = vec![step_for(
        &profile_key,
        &version,
        AgentNativePluginCliCommandV2::AddMarketplace {
            source: source.clone(),
            scope: AgentInstallScopeV2::Managed,
            output: AgentNativePluginCliOutputV2::Json,
        },
    )];
    let authority = PluginNativeTargetBindingAuthority::open_or_create(&root).unwrap();
    let leases = resolve_plugin_native_target_leases(&steps, &host, &authority).unwrap();
    let operation_id = OperationIdV1::new("plugin-orphan-executor-parent").unwrap();
    let started = PluginApplyJournalEventV2 {
        event_id: OperationEventIdV1::new("plugin-orphan-executor-parent-started").unwrap(),
        operation_id: operation_id.clone(),
        sequence: 1,
        body: PluginApplyJournalEventBodyV2::Started {
            idempotency_key: "plugin-orphan-executor-parent-request".to_string(),
            plugin_id: PluginIdV2::new("dure.beads").unwrap(),
            plugin_version: version.clone(),
            compensation_for: None,
            target_bindings: Some(leases.bindings().to_vec()),
            operation_kind: PluginApplyOperationKindV2::Install,
            steps,
        },
        recorded_at_ms: 1,
    };

    tauri::async_runtime::block_on(async {
        let store = SqliteDomainStore::open(root.join("domain.sqlite"))
            .await
            .unwrap();
        store.append_plugin_apply_event(&started).await.unwrap();
        PluginNativeApplyExecutor::default()
            .advance(
                &store,
                PluginNativeApplyExecutorRequest {
                    operation_id: &operation_id,
                    marketplace_source: &source,
                    host: &host,
                    target_binding_authority: &authority,
                },
            )
            .await
            .unwrap();
        store.close().await;
    });
}

#[test]
fn production_executor_provider_retains_the_exact_lock_after_parent_crash() {
    let fixture = Fixture::new();
    fs::write(fixture.profile.join("block-mutation"), b"block").unwrap();
    let release = MutationRelease(fixture.profile.join("release-mutation"));
    let child = Command::new(std::env::current_exe().unwrap())
        .arg("--exact")
        .arg("plugin_native_apply_executor::tests::orphan_executor_parent_helper")
        .arg("--nocapture")
        .env(ORPHAN_EXECUTOR_ROOT, fixture._temp.path())
        .spawn()
        .unwrap();
    let mut child = OwnedExecutorParent(child);
    wait_for_file(&fixture.profile.join("mutation-entered"));

    let host = fixture.host();
    let leases = resolve_plugin_native_target_leases(
        &install_steps(&fixture),
        &host,
        &target_binding_authority(&fixture),
    )
    .unwrap();
    assert!(matches!(
        leases.try_acquire_execution_lease().unwrap(),
        PluginNativeTargetExecutionLeaseDisposition::Occupied
    ));
    child.0.kill().unwrap();
    child.0.wait().unwrap();
    assert!(matches!(
        leases.try_acquire_execution_lease().unwrap(),
        PluginNativeTargetExecutionLeaseDisposition::Occupied
    ));

    release.release();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match leases.try_acquire_execution_lease().unwrap() {
            PluginNativeTargetExecutionLeaseDisposition::Acquired(_) => break,
            PluginNativeTargetExecutionLeaseDisposition::Occupied => {
                assert!(
                    Instant::now() < deadline,
                    "orphan provider retained the production lease after exit"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }
}

#[test]
fn applies_codex_marketplace_and_plugin_through_the_durable_journal() {
    tauri::async_runtime::block_on(async {
        let fixture = Fixture::new();
        let store = open_store(&fixture).await;
        let operation_id = OperationIdV1::new("plugin-install-e2e").unwrap();
        store
            .append_plugin_apply_event(&started_event(
                &fixture,
                &operation_id,
                PluginApplyOperationKindV2::Install,
                install_steps(&fixture),
            ))
            .await
            .unwrap();

        let source = fixture.marketplace_source();
        let host = fixture.host();
        let outcome = PluginNativeApplyExecutor::default()
            .advance(
                &store,
                PluginNativeApplyExecutorRequest {
                    operation_id: &operation_id,
                    marketplace_source: &source,
                    host: &host,
                    target_binding_authority: &target_binding_authority(&fixture),
                },
            )
            .await
            .unwrap();

        let PluginNativeApplyExecutorOutcomeV2::Succeeded(receipt) = outcome else {
            panic!("install must reach a terminal success receipt");
        };
        assert_eq!(receipt.state, PluginApplyJournalStateV2::Succeeded);
        assert_eq!(receipt.effects.len(), 2);
        assert!(fixture.profile.join("marketplace").is_file());
        assert!(fixture.profile.join("installed").is_file());
        assert!(!fixture.profile.join("executed").exists());
        let error = PluginNativeApplyExecutor::default()
            .resume_recovery(
                &store,
                PluginNativeApplyExecutorRequest {
                    operation_id: &operation_id,
                    marketplace_source: &source,
                    host: &host,
                    target_binding_authority: &target_binding_authority(&fixture),
                },
                PluginApplyRecoveryStrategyV2::CompensateOwned,
            )
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            PluginNativeApplyExecutorError::Decision(
                PluginApplyExecutionDecisionErrorV2::RecoveryNotRequired
            )
        ));
        store.close().await;
    });
}

#[test]
fn rejects_unowned_removal_before_executing_the_native_cli() {
    tauri::async_runtime::block_on(async {
        let fixture = Fixture::new();
        let store = open_store(&fixture).await;
        let operation_id = OperationIdV1::new("plugin-remove-unowned").unwrap();
        store
            .append_plugin_apply_event(&started_event(
                &fixture,
                &operation_id,
                PluginApplyOperationKindV2::Uninstall,
                vec![remove_step(&fixture)],
            ))
            .await
            .unwrap();

        let source = fixture.marketplace_source();
        let host = fixture.host();
        let error = PluginNativeApplyExecutor::default()
            .advance(
                &store,
                PluginNativeApplyExecutorRequest {
                    operation_id: &operation_id,
                    marketplace_source: &source,
                    host: &host,
                    target_binding_authority: &target_binding_authority(&fixture),
                },
            )
            .await
            .unwrap_err();

        assert!(matches!(
            error,
            PluginNativeApplyExecutorError::OwnershipRequired
        ));
        assert!(!fixture.profile.join("executed").exists());
        let receipt = store
            .plugin_apply_receipt(&operation_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(receipt.last_sequence, 1);
        assert_eq!(receipt.state, PluginApplyJournalStateV2::Applying);
        store.close().await;
    });
}

#[test]
fn uninstall_uses_and_consumes_only_store_owned_components() {
    tauri::async_runtime::block_on(async {
        let fixture = Fixture::new();
        let store = open_store(&fixture).await;
        let source = fixture.marketplace_source();
        let host = fixture.host();
        let install_operation = OperationIdV1::new("plugin-install-before-remove").unwrap();
        store
            .append_plugin_apply_event(&started_event(
                &fixture,
                &install_operation,
                PluginApplyOperationKindV2::Install,
                install_steps(&fixture),
            ))
            .await
            .unwrap();
        PluginNativeApplyExecutor::default()
            .advance(
                &store,
                PluginNativeApplyExecutorRequest {
                    operation_id: &install_operation,
                    marketplace_source: &source,
                    host: &host,
                    target_binding_authority: &target_binding_authority(&fixture),
                },
            )
            .await
            .unwrap();

        let uninstall = uninstall_steps(&fixture);
        let owned_keys = uninstall
            .iter()
            .map(|step| plugin_native_ownership_target(step).unwrap().key)
            .collect::<Vec<_>>();
        for key in &owned_keys {
            assert!(store.plugin_native_ownership(key).await.unwrap().is_some());
        }

        let uninstall_operation = OperationIdV1::new("plugin-remove-owned").unwrap();
        store
            .append_plugin_apply_event(&started_event(
                &fixture,
                &uninstall_operation,
                PluginApplyOperationKindV2::Uninstall,
                uninstall,
            ))
            .await
            .unwrap();
        let outcome = PluginNativeApplyExecutor::default()
            .advance(
                &store,
                PluginNativeApplyExecutorRequest {
                    operation_id: &uninstall_operation,
                    marketplace_source: &source,
                    host: &host,
                    target_binding_authority: &target_binding_authority(&fixture),
                },
            )
            .await
            .unwrap();

        assert!(matches!(
            outcome,
            PluginNativeApplyExecutorOutcomeV2::Succeeded(_)
        ));
        for key in owned_keys {
            assert!(store.plugin_native_ownership(&key).await.unwrap().is_none());
        }
        assert!(!fixture.profile.join("marketplace").exists());
        assert!(!fixture.profile.join("installed").exists());
        assert!(fixture.profile.join("executed").is_file());
        store.close().await;
    });
}

#[test]
fn rebound_target_is_rejected_before_owned_removal_or_inspection() {
    tauri::async_runtime::block_on(async {
        let fixture = Fixture::new();
        let store = open_store(&fixture).await;
        let source = fixture.marketplace_source();
        let original_host = fixture.host();
        let install_operation = OperationIdV1::new("plugin-install-before-rebind").unwrap();
        store
            .append_plugin_apply_event(&started_event(
                &fixture,
                &install_operation,
                PluginApplyOperationKindV2::Install,
                install_steps(&fixture),
            ))
            .await
            .unwrap();
        PluginNativeApplyExecutor::default()
            .advance(
                &store,
                PluginNativeApplyExecutorRequest {
                    operation_id: &install_operation,
                    marketplace_source: &source,
                    host: &original_host,
                    target_binding_authority: &target_binding_authority(&fixture),
                },
            )
            .await
            .unwrap();

        let uninstall_operation = OperationIdV1::new("plugin-remove-after-rebind").unwrap();
        store
            .append_plugin_apply_event(&started_event(
                &fixture,
                &uninstall_operation,
                PluginApplyOperationKindV2::Uninstall,
                uninstall_steps(&fixture),
            ))
            .await
            .unwrap();
        let rebound_profile = fixture._temp.path().join("rebound-profile");
        fs::create_dir(&rebound_profile).unwrap();
        let rebound_targets =
            BTreeMap::from([(fixture.profile_key.clone(), rebound_profile.clone())]);
        let rebound_host = PluginNativeCliHostContext {
            physical_targets: &rebound_targets,
            ..fixture.host()
        };
        let error = PluginNativeApplyExecutor::default()
            .advance(
                &store,
                PluginNativeApplyExecutorRequest {
                    operation_id: &uninstall_operation,
                    marketplace_source: &source,
                    host: &rebound_host,
                    target_binding_authority: &target_binding_authority(&fixture),
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            PluginNativeApplyExecutorError::Store(DomainStoreErrorV1::IdentityConflict {
                entity: "plugin_native_operation_target_bindings",
                ..
            })
        ));
        assert!(!rebound_profile.join("executed").exists());
        assert!(!rebound_profile.join("marketplace").exists());
        assert_eq!(
            store
                .plugin_apply_receipt(&uninstall_operation)
                .await
                .unwrap()
                .unwrap()
                .last_sequence,
            1
        );
        store.close().await;
    });
}

#[test]
fn legacy_unbound_ownership_cannot_authorize_removal_after_migration() {
    tauri::async_runtime::block_on(async {
        let fixture = Fixture::new();
        let path = fixture.store_path();
        let store = open_store(&fixture).await;
        let source = fixture.marketplace_source();
        let host = fixture.host();
        let install_operation = OperationIdV1::new("plugin-legacy-owner").unwrap();
        store
            .append_plugin_apply_event(&started_event(
                &fixture,
                &install_operation,
                PluginApplyOperationKindV2::Install,
                install_steps(&fixture),
            ))
            .await
            .unwrap();
        PluginNativeApplyExecutor::default()
            .advance(
                &store,
                PluginNativeApplyExecutorRequest {
                    operation_id: &install_operation,
                    marketplace_source: &source,
                    host: &host,
                    target_binding_authority: &target_binding_authority(&fixture),
                },
            )
            .await
            .unwrap();
        let mutations_before = fs::read(fixture.profile.join("mutations")).unwrap();
        store.close().await;

        let mut connection = SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(&path)
                .create_if_missing(false)
                .foreign_keys(false),
        )
        .await
        .unwrap();
        sqlx::query(
            "UPDATE plugin_apply_events SET body_json = json_remove(body_json, '$.target_bindings') WHERE operation_id = ?1 AND sequence = 1",
        )
        .bind(install_operation.as_str())
        .execute(&mut connection)
        .await
        .unwrap();
        sqlx::query("DROP TABLE plugin_native_target_bindings")
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::query("DROP TABLE IF EXISTS agent_dispatch_stops")
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::query("ALTER TABLE workflow_dispatches DROP COLUMN completion_result")
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::query("UPDATE store_metadata SET schema_version = 7 WHERE singleton = 1")
            .execute(&mut connection)
            .await
            .unwrap();
        connection.close().await.unwrap();

        let migrated = open_store(&fixture).await;
        assert!(migrated
            .plugin_apply_receipt(&install_operation)
            .await
            .unwrap()
            .unwrap()
            .target_bindings
            .is_none());
        let mut legacy_replay = started_event(
            &fixture,
            &install_operation,
            PluginApplyOperationKindV2::Install,
            install_steps(&fixture),
        );
        let PluginApplyJournalEventBodyV2::Started {
            target_bindings, ..
        } = &mut legacy_replay.body
        else {
            unreachable!();
        };
        *target_bindings = None;
        migrated
            .append_plugin_apply_event(&legacy_replay)
            .await
            .unwrap();
        let uninstall_operation = OperationIdV1::new("plugin-remove-legacy-owner").unwrap();
        migrated
            .append_plugin_apply_event(&started_event(
                &fixture,
                &uninstall_operation,
                PluginApplyOperationKindV2::Uninstall,
                uninstall_steps(&fixture),
            ))
            .await
            .unwrap();
        let error = PluginNativeApplyExecutor::default()
            .advance(
                &migrated,
                PluginNativeApplyExecutorRequest {
                    operation_id: &uninstall_operation,
                    marketplace_source: &source,
                    host: &host,
                    target_binding_authority: &target_binding_authority(&fixture),
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            PluginNativeApplyExecutorError::OwnershipBindingRequired
        ));
        assert_eq!(
            fs::read(fixture.profile.join("mutations")).unwrap(),
            mutations_before
        );
        assert!(!fixture.profile.join("executed").exists());
        migrated.close().await;
    });
}

#[test]
fn independent_executors_run_each_native_mutation_at_most_once() {
    let fixture = Fixture::new();
    fs::write(fixture.profile.join("block-mutation"), b"block").unwrap();
    let operation_id = OperationIdV1::new("plugin-concurrent-executors").unwrap();
    tauri::async_runtime::block_on(async {
        let store = open_store(&fixture).await;
        store
            .append_plugin_apply_event(&started_event(
                &fixture,
                &operation_id,
                PluginApplyOperationKindV2::Install,
                install_steps(&fixture),
            ))
            .await
            .unwrap();
        store.close().await;
    });

    let (first_outcome, second_outcome, calls_before, calls_after, late_receipt) =
        std::thread::scope(|scope| {
            let release = MutationRelease(fixture.profile.join("release-mutation"));
            let first = scope.spawn(|| {
                tauri::async_runtime::block_on(async {
                    let store = open_store(&fixture).await;
                    let source = fixture.marketplace_source();
                    let host = fixture.host();
                    let result = PluginNativeApplyExecutor::default()
                        .advance(
                            &store,
                            PluginNativeApplyExecutorRequest {
                                operation_id: &operation_id,
                                marketplace_source: &source,
                                host: &host,
                                target_binding_authority: &target_binding_authority(&fixture),
                            },
                        )
                        .await;
                    store.close().await;
                    result
                })
            });
            wait_for_file(&fixture.profile.join("mutation-entered"));
            let calls_before = fs::read(fixture.profile.join("invocations")).unwrap();
            let (second_outcome, late_receipt) = tauri::async_runtime::block_on(async {
                let store = open_store(&fixture).await;
                let source = fixture.marketplace_source();
                let host = fixture.host();
                let result = PluginNativeApplyExecutor::default()
                    .advance(
                        &store,
                        PluginNativeApplyExecutorRequest {
                            operation_id: &operation_id,
                            marketplace_source: &source,
                            host: &host,
                            target_binding_authority: &target_binding_authority(&fixture),
                        },
                    )
                    .await;
                let receipt = store
                    .plugin_apply_receipt(&operation_id)
                    .await
                    .unwrap()
                    .unwrap();
                store.close().await;
                (result, receipt)
            });
            let calls_after = fs::read(fixture.profile.join("invocations")).unwrap();
            release.release();
            (
                first.join().unwrap(),
                second_outcome,
                calls_before,
                calls_after,
                late_receipt,
            )
        });
    assert!(matches!(
        first_outcome,
        Ok(PluginNativeApplyExecutorOutcomeV2::Succeeded(_))
    ));
    assert!(matches!(
        second_outcome,
        Ok(PluginNativeApplyExecutorOutcomeV2::ExecutionInProgress(_))
    ));
    assert_eq!(calls_before, calls_after);
    assert_eq!(late_receipt.last_sequence, 2);
    assert!(matches!(
        late_receipt.recovery,
        PluginApplyRecoveryDirectiveV2::InspectBeforeRetry { .. }
    ));
    assert_eq!(
        fs::read_to_string(fixture.profile.join("mutations")).unwrap(),
        "marketplace\nplugin\n"
    );
}

#[test]
fn compensates_owned_effects_through_a_restart_safe_child_operation() {
    tauri::async_runtime::block_on(async {
        let fixture = Fixture::new();
        let store = CompensationFaultStore {
            inner: open_store(&fixture).await,
            fail_child_start: AtomicBool::new(true),
            fail_parent_completion: AtomicBool::new(false),
        };
        let operation_id = OperationIdV1::new("plugin-install-compensated").unwrap();
        store
            .append_plugin_apply_event(&started_event(
                &fixture,
                &operation_id,
                PluginApplyOperationKindV2::Install,
                install_steps(&fixture),
            ))
            .await
            .unwrap();
        fs::write(fixture.profile.join("fail-install"), b"fail once").unwrap();

        let source = fixture.marketplace_source();
        let host = fixture.host();
        let executor = PluginNativeApplyExecutor::default();
        let first = executor
            .advance(
                &store,
                PluginNativeApplyExecutorRequest {
                    operation_id: &operation_id,
                    marketplace_source: &source,
                    host: &host,
                    target_binding_authority: &target_binding_authority(&fixture),
                },
            )
            .await
            .unwrap();
        let PluginNativeApplyExecutorOutcomeV2::RecoveryRequired(failed) = first else {
            panic!("fault-injected install must require explicit recovery");
        };
        assert_eq!(failed.effects.len(), 1);
        assert!(!fixture.profile.join("marketplace").exists());
        assert!(!fixture.profile.join("installed").exists());

        let resumed = executor
            .resume_recovery(
                &store,
                PluginNativeApplyExecutorRequest {
                    operation_id: &operation_id,
                    marketplace_source: &source,
                    host: &host,
                    target_binding_authority: &target_binding_authority(&fixture),
                },
                PluginApplyRecoveryStrategyV2::CompensateOwned,
            )
            .await
            .unwrap();
        assert_eq!(resumed.state, PluginApplyJournalStateV2::Compensating);
        let interrupted = executor
            .advance(
                &store,
                PluginNativeApplyExecutorRequest {
                    operation_id: &operation_id,
                    marketplace_source: &source,
                    host: &host,
                    target_binding_authority: &target_binding_authority(&fixture),
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(
            interrupted,
            PluginNativeApplyExecutorError::Store(DomainStoreErrorV1::Storage {
                code: "injected_compensation_child_start",
                ..
            })
        ));
        let linked = store
            .plugin_apply_receipt(&operation_id)
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            linked.recovery,
            PluginApplyRecoveryDirectiveV2::RunCompensation { .. }
        ));
        let child_operation_id = linked.compensation.as_ref().unwrap().operation_id.clone();
        assert!(store
            .plugin_apply_receipt(&child_operation_id)
            .await
            .unwrap()
            .is_none());
        drop(store);

        let resumed_store = CompensationFaultStore {
            inner: open_store(&fixture).await,
            fail_child_start: AtomicBool::new(false),
            fail_parent_completion: AtomicBool::new(true),
        };
        let interrupted_after_child = PluginNativeApplyExecutor::default()
            .advance(
                &resumed_store,
                PluginNativeApplyExecutorRequest {
                    operation_id: &operation_id,
                    marketplace_source: &source,
                    host: &host,
                    target_binding_authority: &target_binding_authority(&fixture),
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(
            interrupted_after_child,
            PluginNativeApplyExecutorError::Store(DomainStoreErrorV1::Storage {
                code: "injected_compensation_parent_completion",
                ..
            })
        ));
        let parent_before_completion = resumed_store
            .plugin_apply_receipt(&operation_id)
            .await
            .unwrap()
            .unwrap();
        let child_before_completion = resumed_store
            .plugin_apply_receipt(&child_operation_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            parent_before_completion.state,
            PluginApplyJournalStateV2::Compensating
        );
        assert_eq!(
            child_before_completion.state,
            PluginApplyJournalStateV2::Succeeded
        );
        let executed_before = fs::read(fixture.profile.join("executed")).unwrap();
        drop(resumed_store);

        let reopened = open_store(&fixture).await;
        let outcome = PluginNativeApplyExecutor::default()
            .advance(
                &reopened,
                PluginNativeApplyExecutorRequest {
                    operation_id: &operation_id,
                    marketplace_source: &source,
                    host: &host,
                    target_binding_authority: &target_binding_authority(&fixture),
                },
            )
            .await
            .unwrap();
        let PluginNativeApplyExecutorOutcomeV2::Compensated(parent) = outcome else {
            panic!("restart must terminalize the already successful compensation child");
        };
        assert_eq!(parent.state, PluginApplyJournalStateV2::Compensated);
        let link = parent.compensation.as_ref().unwrap();
        let child = reopened
            .plugin_apply_receipt(&link.operation_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(child.state, PluginApplyJournalStateV2::Succeeded);
        assert_eq!(child.compensation_for.as_ref(), Some(&operation_id));
        assert!(!fixture.profile.join("marketplace").exists());
        assert!(!fixture.profile.join("installed").exists());
        assert_eq!(
            fs::read(fixture.profile.join("executed")).unwrap(),
            executed_before
        );
        reopened.close().await;
        let reopened_terminal = open_store(&fixture).await;
        let after_restart = PluginNativeApplyExecutor::default()
            .advance(
                &reopened_terminal,
                PluginNativeApplyExecutorRequest {
                    operation_id: &operation_id,
                    marketplace_source: &source,
                    host: &host,
                    target_binding_authority: &target_binding_authority(&fixture),
                },
            )
            .await
            .unwrap();
        assert!(matches!(
            after_restart,
            PluginNativeApplyExecutorOutcomeV2::Compensated(_)
        ));
        assert_eq!(
            fs::read(fixture.profile.join("executed")).unwrap(),
            executed_before
        );
        reopened_terminal.close().await;
    });
}
