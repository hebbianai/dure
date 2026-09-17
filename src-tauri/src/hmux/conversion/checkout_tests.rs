use super::*;
use hmux_client::{ManagedSessionCreator, StandaloneSessionCreator};
use crate::ssh::shell_quote;
use dure_app::{GitCheckoutRemovalPolicyV1, GitCheckoutRemovalRequestV1, OperationIdV1};
use dure_git_checkout::{
    capture_git_checkout_registration, read_git_checkout_claims, GitCheckoutRemovalOperation,
};
use hmux_client::ProviderConversationIdentitySeed;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;

mod managed_advance;
mod managed_source;
mod fixture;
mod namespaces;
mod standalone_close;
mod standalone_handoff;
mod target_collision;
use managed_source::stop_source;

const CONVERSATION: &str = "019fa342-4698-78b2-a47d-784690b3c756";

fn git(root: &Path, arguments: &[&str]) {
    let mut command = Command::new("git");
    crate::gitx::scrub_git_environment(&mut command);
    let output = command
        .current_dir(root)
        .args([
            "-c",
            "user.name=QA",
            "-c",
            "user.email=qa@qa",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(arguments)
        .output()
        .unwrap();
    assert!(output.status.success(), "Git fixture failed: {output:?}");
}

fn private_file(path: &Path, content: &str, mode: u32) {
    fs::write(path, content).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
}

fn fixture_provider(home: &Path, checkout: &Path) -> PathBuf {
    let repository = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let tui = repository.join("scripts/qa/fake-provider/codex");
    let native = repository.join("scripts/qa/fake-provider/codex-native.mjs");
    fs::create_dir(home.join("provider-capture")).unwrap();
    let provider_home = home.join(".codex");
    let sessions = provider_home.join("sessions/2026/07/28");
    fs::create_dir_all(&sessions).unwrap();
    let rollout = sessions.join(format!("rollout-2026-07-28T00-00-00-{CONVERSATION}.jsonl"));
    private_file(
        &rollout,
        &serde_json::json!({
            "type": "session_meta",
            "payload": {"id": CONVERSATION, "cwd": checkout, "originator": "codex-tui", "source": "cli"}
        }).to_string(),
        0o600,
    );
    let database = provider_home.join("state_5.sqlite");
    private_file(&database, "", 0o600);
    let bin = home.join("bin");
    fs::create_dir(&bin).unwrap();
    let provider = bin.join("codex");
    // Keep the same fake TUI used by terminal QA. Only this fixture wrapper
    // supplies private rollout/database descriptors for real OS inspection.
    private_file(
        &provider,
        &format!(
            "#!/bin/sh\nexec 3<{}\nexec 4<{}\nexport DURE_QA_CAPTURE_DIR={}\nexport DURE_HMUX_TEST_STATE_ROOT={}\ncase \"${{1:-}}\" in --version|-v) exec {} \"$@\" ;; esac\nexec node {} \"$@\"\n",
            shell_quote(&rollout.to_string_lossy()),
            shell_quote(&database.to_string_lossy()),
            shell_quote(&home.join("provider-capture").to_string_lossy()),
            shell_quote(&home.parent().unwrap().to_string_lossy()),
            shell_quote(&tui.to_string_lossy()),
            shell_quote(&native.to_string_lossy()),
        ),
        0o700,
    );
    private_file(
        &home.join(".profile"),
        &format!(
            "export PATH={}:\"$PATH\"\n",
            shell_quote(&bin.to_string_lossy())
        ),
        0o600,
    );
    let resolved = Command::new("/bin/sh")
        .args(["-lc", "command -v codex"])
        .output()
        .unwrap();
    assert!(resolved.status.success());
    assert_eq!(
        String::from_utf8(resolved.stdout).unwrap().trim(),
        provider.to_str().unwrap()
    );
    provider
}

#[test]
#[ignore = "requires isolated native app roots and staged Hmux binaries"]
fn native_managed_conversion_close_releases_checkout_ownership() {
    conversion_fixture(ConversionCase::Managed);
}

#[test]
#[ignore = "requires its own isolated native app process and staged Hmux binaries"]
fn native_standalone_conversion_close_releases_checkout_ownership() {
    conversion_fixture(ConversionCase::Standalone);
}

#[test]
#[ignore = "requires its own isolated native app process and staged Hmux binaries"]
fn native_rehosted_source_conversion_close_releases_checkout_ownership() {
    conversion_fixture(ConversionCase::Rehosted);
}

#[test]
#[ignore = "requires its own isolated native app process and staged Hmux binaries"]
fn native_interrupted_conversion_resumes_without_client_conversation_hint() {
    conversion_fixture(ConversionCase::Interrupted);
}

#[test]
#[ignore = "requires isolated native app roots and staged Hmux binaries"]
fn native_managed_conversion_retains_direct_launch_rehost_authority() {
    conversion_fixture(ConversionCase::ManagedLaunch);
}

#[test]
#[ignore = "requires isolated native app roots and staged Hmux binaries"]
fn native_interrupted_conversion_uses_prepared_launch_after_cli_projection_loss() {
    conversion_fixture(ConversionCase::PreparedLaunch);
}

#[test]
#[ignore = "requires isolated native app roots and staged Hmux binaries"]
fn native_standalone_conversion_refuses_unowned_named_target_before_source_stop() {
    conversion_fixture(ConversionCase::NamedCollision);
}

#[test]
#[ignore = "requires isolated native app roots and staged Hmux binaries"]
fn native_standalone_conversion_refuses_same_id_with_another_create_before_source_stop() {
    conversion_fixture(ConversionCase::StandaloneIdentityCollision);
}

#[test]
#[ignore = "requires isolated native app roots and staged Hmux binaries"]
fn native_standalone_conversion_reuses_its_exact_create_after_response_loss() {
    conversion_fixture(ConversionCase::StandaloneReplay);
}

#[test]
#[ignore = "requires isolated native app roots and staged Hmux binaries"]
fn native_managed_conversion_refuses_another_create_before_source_stop() {
    conversion_fixture(ConversionCase::ManagedCollision);
}

#[test]
#[ignore = "requires isolated native app roots and staged Hmux binaries"]
fn native_managed_conversion_reuses_its_exact_create_after_response_loss() {
    conversion_fixture(ConversionCase::ManagedReplay);
}

#[test]
#[ignore = "requires isolated native app roots and staged Hmux binaries"]
fn native_standalone_close_releases_its_transferred_checkout() {
    conversion_fixture(ConversionCase::StandaloneTransferredClose);
}

#[test]
#[ignore = "requires isolated native app roots and staged Hmux binaries"]
fn native_standalone_conversion_does_not_recreate_its_retired_replacement() {
    conversion_fixture(ConversionCase::StandaloneRetiredReplay);
}

#[test]
#[ignore = "requires isolated native app roots and staged Hmux binaries"]
fn native_completed_standalone_conversion_reports_its_retired_replacement() {
    conversion_fixture(ConversionCase::StandaloneCompletedRetiredReplay);
}

#[test]
#[ignore = "requires isolated native app roots and staged Hmux binaries"]
fn native_managed_replacement_advance_preserves_checkout_until_close() {
    conversion_fixture(ConversionCase::ManagedTargetAdvance);
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum ConversionCase {
    Managed,
    Standalone,
    Rehosted,
    Interrupted,
    ManagedLaunch,
    PreparedLaunch,
    NamedCollision,
    StandaloneIdentityCollision,
    StandaloneReplay,
    ManagedCollision,
    ManagedReplay,
    StandaloneTransferredClose,
    StandaloneCloseRetry,
    StandaloneCloseReconcile,
    StandaloneRetiredReplay,
    StandaloneCompletedRetiredReplay,
    ManagedTargetAdvance,
    ManagedSourceReopen,
    RehostedSourceReopen,
    StandaloneSourceClose,
    StandaloneRoundtrip,
}

fn conversion_fixture(case: ConversionCase) {
    let target_class = if matches!(
        case,
        ConversionCase::Standalone
            | ConversionCase::NamedCollision
            | ConversionCase::StandaloneIdentityCollision
            | ConversionCase::StandaloneReplay
            | ConversionCase::StandaloneTransferredClose
            | ConversionCase::StandaloneCloseRetry
            | ConversionCase::StandaloneCloseReconcile
            | ConversionCase::StandaloneRetiredReplay
            | ConversionCase::StandaloneCompletedRetiredReplay
            | ConversionCase::StandaloneSourceClose
            | ConversionCase::StandaloneRoundtrip
    ) {
        SessionConversionTarget::Standalone
    } else {
        SessionConversionTarget::Managed
    };
    let fixture::ConversionFixture {
        home, app_home, discovery, checkout, app, manager, current, create, mut source,
    } = fixture::ConversionFixture::new(target_class, None);
    let channel = crate::app_channel::current().unwrap();
    let origin = source.session().descriptor().clone();
    if matches!(
        case,
        ConversionCase::Rehosted | ConversionCase::RehostedSourceReopen
    ) {
        // Keep the product claim on the original create, as real rehost does.
        // The converter must discover it through the runtime's actual ancestry.
        ManagedSessionStopper::new(&current.runtime, current.runtime.parent().unwrap())
            .stop(managed_stop_request_for_descriptor("retire-fixture-origin", &origin).unwrap())
            .unwrap();
        drop(source);
        let hmux_client::ManagedCreateAdvanceResolution::Advanced(replacement) =
            ManagedSessionCreator::new(&current.runtime)
                .with_discovery_root(&discovery)
                .create_or_reconcile_and_advance(create.clone())
                .unwrap()
        else {
            panic!("the native source fixture must advance through the real runtime lineage");
        };
        assert_ne!(replacement.receipt().session_id(), origin.session_id);
        fixture::wait_for_provider_start(&home, replacement.session().descriptor());
        source = replacement;
    }
    let source_descriptor = source.session().descriptor().clone();
    let source_key = source.receipt().idempotency_key().to_owned();
    let registration = capture_git_checkout_registration(&checkout)
        .unwrap()
        .unwrap();
    assert_eq!(read_git_checkout_claims(&registration).unwrap().len(), 1);
    drop(source);
    let mut request = fixture::request(
        "convert-checkout-shell", &checkout, &source_descriptor, target_class,
    );
    let expected_colors = matches!(
        case,
        ConversionCase::Managed | ConversionCase::Standalone | ConversionCase::Interrupted
    ).then(|| hmux_client::TerminalDefaultColors::new(0x171717, 0xffffff).unwrap());
    request.terminal_default_colors = expected_colors;
    let preview = manager
        .convert_session(app.handle(), request.clone())
        .unwrap();
    assert_eq!(
        preview.reason.as_deref(),
        Some("update_requires_confirmation")
    );
    assert_eq!(preview.conversation_id.as_deref(), Some(CONVERSATION));
    request.confirmed = true;
    if case == ConversionCase::StandaloneRoundtrip {
        standalone_handoff::assert_roundtrip_releases_checkout(
            &manager,
            app.handle(),
            &request,
            &source_descriptor,
            &source_key,
        );
        return;
    }
    if case == ConversionCase::StandaloneSourceClose {
        standalone_handoff::assert_source_close_preserves_target(
            &manager,
            app.handle(),
            &request,
            &source_descriptor,
            &source_key,
        );
        return;
    }
    if matches!(
        case,
        ConversionCase::ManagedSourceReopen | ConversionCase::RehostedSourceReopen
    ) {
        managed_source::assert_source_stays_closed(
            &manager,
            app.handle(),
            &current,
            &request,
            create,
        );
        return;
    }
    if case == ConversionCase::ManagedTargetAdvance {
        managed_advance::assert_replacement_handoff(
            &manager,
            app.handle(),
            &current,
            &request,
            &source_descriptor,
            &source_key,
        );
        return;
    }
    if matches!(
        case,
        ConversionCase::StandaloneRetiredReplay | ConversionCase::StandaloneCompletedRetiredReplay
    ) {
        assert_retired_replacement_is_not_recreated(
            &manager,
            app.handle(),
            &current,
            &request,
            &source_descriptor,
            &source_key,
            case == ConversionCase::StandaloneCompletedRetiredReplay,
        );
        return;
    }
    if matches!(
        case,
        ConversionCase::NamedCollision
            | ConversionCase::StandaloneIdentityCollision
            | ConversionCase::ManagedCollision
    ) {
        target_collision::assert_unowned_target_is_not_adopted(
            &manager,
            app.handle(),
            &current,
            &request,
            &source_descriptor,
            &source_key,
            case == ConversionCase::StandaloneIdentityCollision,
        );
        return;
    }
    let expected_recipe =
        (case == ConversionCase::ManagedLaunch).then(|| direct_launch_recipe(&request));
    let mut prior_target = None;
    if matches!(
        case,
        ConversionCase::Interrupted
            | ConversionCase::PreparedLaunch
            | ConversionCase::StandaloneReplay
            | ConversionCase::ManagedReplay
    ) {
        // Exercise the same reservation and exact retirement as conversion,
        // then lose the caller before replacement. The retry has no optional
        // conversation hint and must use its already admitted execution input.
        let catalog = LocalSessionCatalog::new(&discovery);
        let state = operation::reserve(&catalog, request.clone(), |request, checkpoint| {
            launch::prepare(&catalog, request, checkpoint, current.clone())
        })
        .unwrap();
        let operation::ReservedConversion::Pending(pending) = state else {
            panic!("fresh fixture conversion must be pending");
        };
        let (prepared, mut reservation) = *pending;
        let identity =
            inspect_source_provider(&source_descriptor, &prepared.request, &checkout).unwrap();
        let mut checkpoint = checkpoint_from_identity(&identity, &source_descriptor);
        reservation.checkpoint_resume(checkpoint.clone()).unwrap();
        prepared.retain_source_checkout(&catalog).unwrap();
        stop_source(
            &catalog,
            &current.runtime,
            &prepared.request,
            &source_descriptor,
            &checkpoint,
        )
        .unwrap();
        checkpoint.source_terminated = true;
        reservation.checkpoint_resume(checkpoint).unwrap();
        drop(reservation);
        if matches!(
            case,
            ConversionCase::StandaloneReplay | ConversionCase::ManagedReplay
        ) {
            let created = match &prepared.launch {
                launch::PreparedLaunch::Standalone(create) => {
                    StandaloneSessionCreator::new(&current.runtime)
                        .create(create.as_ref().clone())
                        .unwrap()
                        .session()
                        .descriptor()
                        .clone()
                }
                launch::PreparedLaunch::Managed(create) => {
                    ManagedSessionCreator::new(&current.runtime)
                        .create(create.as_ref().clone())
                        .unwrap()
                        .session()
                        .descriptor()
                        .clone()
                }
            };
            // Lose the create response before the conversion records completion.
            prior_target = Some(created);
        }
        eprintln!(
            "isolated retired source: host_timestamp_live={} provider_timestamp_live={} host_generation={:?} provider_generation={:?}",
            adoption::source_host_matches(&identity),
            adoption::source_provider_matches(&identity),
            hmux_client::probe_local_process_generation(&source_descriptor.host_process),
            hmux_client::probe_local_process_generation(&source_descriptor.provider_process),
        );
        assert_eq!(
            catalog
                .find(&SessionSelector::new(
                    &source_descriptor.session_id,
                    Some(source_descriptor.workspace_id.clone())
                ))
                .unwrap()
                .lifecycle,
            SessionLifecycle::Exited,
        );
        assert_eq!(read_git_checkout_claims(&registration).unwrap().len(), 1);
        request.expected_conversation_id = None;
        if expected_colors.is_some() {
            request.terminal_default_colors =
                Some(hmux_client::TerminalDefaultColors::new(0xe5e5e5, 0x242424).unwrap());
        }
    }
    let removed_cli_projection = if case == ConversionCase::PreparedLaunch {
        let command = crate::dure_cli_install::resolve_channel_dure_command(&channel.name, &home)
            .unwrap()
            .unwrap();
        let link = home
            .join(".local/share/hebbian-ide-cli/channels")
            .join(&channel.name);
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        let destination = fs::read_link(&link).unwrap();
        // Remove only this fixture's mutable locator. The admitted executable
        // remains present, so recovery must use its prepared absolute path.
        fs::remove_file(&link).unwrap();
        assert!(
            crate::dure_cli_install::resolve_channel_dure_command(&channel.name, &home)
                .unwrap()
                .is_none()
        );
        assert!(command.executable.is_file());
        Some((link, destination))
    } else {
        None
    };
    let result = manager.convert_session(app.handle(), request.clone());
    if let Some((link, destination)) = removed_cli_projection {
        std::os::unix::fs::symlink(destination, link).unwrap();
    }
    let converted = match result {
        Ok(converted) if converted.outcome == "converted" => converted,
        other => {
            manager
                .stop_managed_create_chain_v2(
                    app.handle(),
                    &source_key,
                    &source_descriptor.session_id,
                    &source_descriptor.workspace_id,
                )
                .unwrap();
            panic!("conversion failed after native observation and fixture cleanup: {other:?}");
        }
    };
    assert_eq!(converted.conversation_id.as_deref(), Some(CONVERSATION));
    if matches!(
        case,
        ConversionCase::Interrupted
            | ConversionCase::PreparedLaunch
            | ConversionCase::StandaloneReplay
            | ConversionCase::ManagedReplay
    ) {
        assert!(converted.replayed);
    }
    let target = converted.replacement_session.unwrap();
    if let Some(expected) = prior_target {
        assert_eq!(target.session_id, expected.session_id);
        assert_eq!(target.terminal_epoch, expected.terminal_epoch);
        assert!(same_session_generation(
            &expected,
            &product_catalog()
                .unwrap()
                .find(&SessionSelector::new(
                    &target.session_id,
                    Some(target.workspace_id.clone()),
                ))
                .unwrap(),
        ));
    }
    let observed_recipe = if case == ConversionCase::ManagedLaunch
        || (expected_colors.is_some() && target_class == SessionConversionTarget::Managed)
    {
        hmux_client::recovery_journal::managed_create_ledger::managed_rehost_recipe(
            &discovery,
            &target.workspace_id,
            &target.session_id,
        )
        .unwrap()
    } else {
        None
    };
    if case == ConversionCase::StandaloneTransferredClose {
        assert_fixture_checkout_handoff(
            &app_home,
            &discovery,
            &source_descriptor,
            &source_key,
            &target,
        );
    }
    let target_descriptor = product_catalog()
        .unwrap()
        .find(&SessionSelector::new(
            &target.session_id,
            Some(target.workspace_id.clone()),
        ))
        .unwrap();
    fixture::wait_for_provider_start(&home, &target_descriptor);
    let observed_colors = expected_colors.map(|_| {
        let receipt = home.join("provider-capture/terminal-colors")
            .join(format!("{}.json", target.session_id));
        serde_json::from_slice::<serde_json::Value>(&fs::read(receipt).unwrap()).unwrap()
    });
    match target_class {
        SessionConversionTarget::Managed => {
            manager
                .stop_managed_create_chain_v2(
                    app.handle(),
                    &converted.replacement_idempotency_key.unwrap(),
                    &target.session_id,
                    &target.workspace_id,
                )
                .unwrap();
        }
        SessionConversionTarget::Standalone => {
            if matches!(
                case,
                ConversionCase::StandaloneCloseRetry | ConversionCase::StandaloneCloseReconcile
            ) {
                standalone_close::close_after_git_failure(
                    &manager,
                    &app_home,
                    &registration,
                    &target,
                    case,
                );
            } else {
                manager
                    .terminate_standalone_session(
                        &target.session_id,
                        &target.workspace_id,
                        Duration::from_secs(3),
                    )
                    .unwrap();
            }
        }
    }
    let catalog = LocalSessionCatalog::new(discovery);
    for descriptor in [&origin, &source_descriptor, &target_descriptor] {
        assert_fixture_session_closed(&catalog, descriptor);
    }
    let claims = read_git_checkout_claims(&registration).unwrap();
    let removal = GitCheckoutRemovalOperation::new(
        &GitCheckoutRemovalRequestV1 {
            repository_path: registration.repository_path,
            instance: registration.instance,
            policy: GitCheckoutRemovalPolicyV1::RequireClean,
        },
        &OperationIdV1::new("remove-closed-conversion").unwrap(),
    )
    .unwrap()
    .admit()
    .and_then(|permit| permit.abort())
    .map_err(|error| error.code);
    // RED cleanup follows observation and closes only this disposable lifetime.
    // It must not hide a source claim stranded by successful target close.
    manager
        .stop_managed_create_chain_v2(
            app.handle(),
            &source_key,
            &source_descriptor.session_id,
            &source_descriptor.workspace_id,
        )
        .unwrap();
    if case == ConversionCase::ManagedLaunch {
        assert_eq!(
            observed_recipe, expected_recipe,
            "converted managed session lost the direct launch's durable rehost authority"
        );
    }
    if let Some(colors) = expected_colors {
        // Creation hints stay in the durable wire record, but a new Host no
        // longer injects those presentation colors into terminal queries.
        assert_eq!(observed_colors.unwrap(), serde_json::json!({}));
        let operation::ReservedConversion::Completed(completed) =
            operation::reserve(&catalog, request, |_, _| {
                panic!("completed conversion must not prepare another launch")
            }).unwrap()
        else {
            panic!("native conversion must retain its completed journal");
        };
        let prepared: launch::PreparedConversion = serde_json::from_str(
            &completed.1.operation_checkpoint.unwrap().canonical_payload,
        ).unwrap();
        assert_eq!(prepared.request.terminal_default_colors, Some(colors));
        let launch_colors = match prepared.launch {
            launch::PreparedLaunch::Managed(create) => {
                assert_eq!(observed_recipe.unwrap().terminal_default_colors(), Some(colors));
                create.terminal_default_colors()
            }
            launch::PreparedLaunch::Standalone(create) => create.terminal_default_colors(),
        };
        assert_eq!(launch_colors, Some(colors));
    }
    if case == ConversionCase::StandaloneReplay {
        // Standalone replay observes exact runtime identity independently of
        // resource transfer. Managed cases use the pre-cleanup observations.
        assert!(read_git_checkout_claims(
            &capture_git_checkout_registration(&checkout)
                .unwrap()
                .unwrap()
        )
        .unwrap()
        .is_empty());
        return;
    }
    assert_eq!(
        (claims.len(), removal),
        (0, Ok(())),
        "converted target close stranded source membership: {claims:?}"
    );
}

fn assert_fixture_session_closed(catalog: &LocalSessionCatalog, expected: &SessionDescriptor) {
    let selector = SessionSelector::new(&expected.session_id, Some(expected.workspace_id.clone()));
    match catalog.find(&selector) {
        Ok(current) => {
            assert!(same_session_generation(expected, &current));
            assert_eq!(current.lifecycle, SessionLifecycle::Exited);
        }
        Err(error)
            if error.is_session_absent() && expected.session_class == SessionClass::Standalone =>
        {
            // Standalone retirement removes its catalog pointer. Absence alone
            // is not completion: use the exact Host/provider saved before stop.
            assert_eq!(
                catalog.resolve_completed_standalone_target(
                    &hmux_client::ExitedSessionRetirementGeneration::from_descriptor(expected)
                        .unwrap(),
                    &expected.provider_process,
                ),
                hmux_client::CompletedStandaloneTargetLifecycle::Retired
            );
        }
        Err(error) => panic!("closed fixture lost its exact runtime evidence: {error}"),
    }
}

fn create_pending_replacement(
    manager: &HmuxManager,
    current: &runtime::InstalledBuild,
    request: &SessionConversionRequest,
    source: &SessionDescriptor,
) -> Box<SessionSummary> {
    let catalog = product_catalog().unwrap();
    let operation::ReservedConversion::Pending(pending) =
        operation::reserve(&catalog, request.clone(), |request, checkpoint| {
            launch::prepare(&catalog, request, checkpoint, current.clone())
        })
        .unwrap()
    else {
        panic!("fresh conversion must be pending");
    };
    let (prepared, mut reservation) = *pending;
    let mut checkpoint = prepared.initial_checkpoint.clone();
    let identity = identity_from_checkpoint(&checkpoint).unwrap();
    reservation.checkpoint_resume(checkpoint.clone()).unwrap();
    prepared.retain_source_checkout(&catalog).unwrap();
    stop_source(&catalog, &current.runtime, request, source, &checkpoint).unwrap();
    checkpoint.source_terminated = true;
    reservation.checkpoint_resume(checkpoint).unwrap();
    let ReplacementAttempt::Ready(target) = create_replacement(ReplacementContext {
        manager,
        catalog: &catalog,
        prepared: &prepared,
        expected_identity: &identity,
        idempotency_key: &conversion_replacement_idempotency_key(&request.conversion_id, 0),
        attempt: 0,
        reservation: &mut reservation,
    })
    .unwrap() else {
        panic!("fresh replacement must not advance or retire an existing attempt");
    };
    // Lose the caller after the product's actual create step, before the outer
    // conversion completion. A user then closes the successfully created target.
    drop(reservation);
    Box::new(target.session)
}

fn assert_retired_replacement_is_not_recreated<R: tauri::Runtime>(
    manager: &HmuxManager,
    app: &AppHandle<R>,
    current: &runtime::InstalledBuild,
    request: &SessionConversionRequest,
    source: &SessionDescriptor,
    source_key: &str,
    complete_before_close: bool,
) {
    let catalog = product_catalog().unwrap();
    let target = create_pending_replacement(manager, current, request, source);
    if complete_before_close {
        let completed = manager.convert_session(app, request.clone()).unwrap();
        assert_eq!(completed.outcome, "converted");
        assert_eq!(
            completed.replacement_session.unwrap().terminal_epoch,
            target.terminal_epoch
        );
    }
    let selector = SessionSelector::new(&target.session_id, Some(target.workspace_id.clone()));
    let descriptor = catalog.find(&selector).unwrap();
    let generation =
        hmux_client::ExitedSessionRetirementGeneration::from_descriptor(&descriptor).unwrap();
    manager
        .terminate_standalone_session(
            &target.session_id,
            &target.workspace_id,
            Duration::from_secs(3),
        )
        .unwrap();
    // Use the runtime's supported exact-generation retirement, not deletion of
    // discovery files. Host drain may outlive the synchronous stop receipt.
    let deadline = Instant::now() + Duration::from_secs(8);
    let lifecycle = loop {
        let lifecycle =
            catalog.resolve_completed_standalone_target(&generation, &descriptor.provider_process);
        if lifecycle == hmux_client::CompletedStandaloneTargetLifecycle::Retired
            || Instant::now() >= deadline
        {
            break lifecycle;
        }
        thread::sleep(Duration::from_millis(50));
    };
    assert_eq!(
        lifecycle,
        hmux_client::CompletedStandaloneTargetLifecycle::Retired
    );
    assert!(catalog.open(&selector).unwrap_err().is_session_absent());
    let mut retry = request.clone();
    retry.expected_conversation_id = None;
    let result = manager.convert_session(app, retry);
    let refused = matches!(&result, Ok(receipt)
        if receipt.outcome == "refused"
            && receipt.reason.as_deref() == Some("session_conversion_replacement_retired"));
    let absent = catalog
        .open(&selector)
        .is_err_and(|error| error.is_session_absent());
    // Capture the resurrection observation before exact cleanup of a failing
    // implementation. This is not an assertion about checkout handoff yet.
    manager
        .terminate_standalone_session(
            &target.session_id,
            &target.workspace_id,
            Duration::from_secs(3),
        )
        .unwrap();
    manager
        .stop_managed_create_chain_v2(app, source_key, &source.session_id, &source.workspace_id)
        .unwrap();
    assert_eq!(
        (refused, absent),
        (true, true),
        "retired target replay: {result:?}"
    );
}

fn assert_fixture_checkout_handoff(
    app_home: &Path,
    discovery: &Path,
    source: &SessionDescriptor,
    source_key: &str,
    target: &SessionSummary,
) {
    use dure_app::{SessionCheckoutIdentityV1, SessionCheckoutOwnerV1};

    // The real converter now owns transfer. Verify its target against the
    // runtime's published create key before observing the separate close path.
    let namespace = discovery
        .canonicalize()
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    let source_owner = SessionCheckoutIdentityV1 {
        runtime_namespace: namespace.clone(),
        owner: SessionCheckoutOwnerV1::Managed {
            workspace_id: source.workspace_id.clone(),
            session_id: source.session_id.clone(),
            idempotency_key: source_key.to_owned(),
        },
    };
    let target_owner = SessionCheckoutIdentityV1 {
        runtime_namespace: namespace,
        owner: SessionCheckoutOwnerV1::Standalone {
            workspace_id: target.workspace_id.clone(),
            session_id: target.session_id.clone(),
            recovery_id: LocalSessionCatalog::new(discovery)
                .open(&SessionSelector::new(
                    &target.session_id,
                    Some(target.workspace_id.clone()),
                ))
                .unwrap()
                .create_idempotency_key()
                .unwrap()
                .into(),
        },
    };
    tauri::async_runtime::block_on(async {
        let store = dure_app_sqlite::SqliteDomainStore::open(
            app_home.join("backend/application-state.sqlite3"),
        )
        .await
        .unwrap();
        let target_binding = store
            .session_checkout(&target_owner)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(target_binding.binding.claim_id, source_owner.owner_id());
        assert_eq!(target_binding.binding.identity, target_owner);
        assert!(store
            .session_checkout(&source_owner)
            .await
            .unwrap()
            .is_none());
        store.close().await;
    });
}

fn direct_launch_recipe(
    request: &SessionConversionRequest,
) -> hmux_client::ManagedRehostSourceRecipe {
    let prepared = managed_launch::prepare_managed_create_request(ManagedCreateLaunch {
        replace_current: false,
        idempotency_key: conversion_replacement_idempotency_key(&request.conversion_id, 0),
        session_id: conversion_target_session_id(&request.source_session_id, request.target, 0),
        workspace_id: request.source_workspace_id.clone(),
        provider_id: request.provider_id.clone(),
        conversation_id: Some(CONVERSATION.into()),
        initial_prompt: None,
        permission_mode: request.permission_mode,
        credential_id: request.credential_id.clone(),
        credential_generation: request.credential_generation,
        provider_state_environment: resolve_managed_provider_state_environment(
            &request.provider_id,
            request.credential_id.as_deref(),
            request.credential_directory.as_deref(),
        )
        .unwrap(),
        cwd: request.cwd.clone(),
        command: exact_adoption_resume_command(
            &request.provider_id,
            CONVERSATION,
            request.permission_mode,
        )
        .unwrap(),
        rows: request.rows,
        columns: request.columns,
        terminal_environment: request.terminal_environment.clone(),
        terminal_default_colors: hmux_client::TerminalDefaultColors::default(),
    })
    .unwrap();
    hmux_client::ManagedRehostSourceRecipe::from_create_request(&prepared.request)
        .unwrap()
        .expect("direct managed Codex launch must admit a rehost recipe")
}
