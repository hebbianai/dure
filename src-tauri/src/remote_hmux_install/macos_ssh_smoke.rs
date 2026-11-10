//! Real SSH to a real macOS account, driven by `scripts/qa/macos-ssh-host-smoke.mjs`.
//!
//! Provisioning, the checkout helper and the Host are each native code that a
//! fixture cannot stand in for: this is what shows the Apple silicon tree
//! actually executes, starts as the SSH user, and outlives the connection that
//! created it.

use super::*;
use crate::session_checkout::remote::RemoteCheckoutHost;
use dure_session_runtime::host_command::CheckoutHostCommandV1;
use hmux_client::{ManagedCreateRequest, ManagedStopRequest, PermissionMode};
use hmux_ssh_transport::{
    attach_observer_over_ssh, list_sessions_over_ssh, stop_managed_over_ssh, HostKeyPolicy,
    ObserverEvent, RemoteCatalogSession, RemoteSessionLifecycle, SessionFence, SshAuthentication,
    SshEndpoint, SshExecConfig,
};
use std::time::{Duration, Instant};

const MARKER: &[u8] = b"dure-macos-host-ready";
const SESSION: &str = "macos-ssh-session";
const WORKSPACE: &str = "macos-ssh-workspace";
const TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    ssh: crate::ssh::SshOptions,
    resource_dir: std::path::PathBuf,
    home: String,
}

fn exec_config(options: &crate::ssh::SshOptions) -> SshExecConfig {
    let key = options.key_path.as_deref().expect("fixture key path");
    SshExecConfig::new(
        SshEndpoint {
            host: options.host.clone(),
            port: options.port.expect("fixture port"),
        },
        options.user.clone(),
        SshAuthentication::PrivateKey {
            openssh_pem: std::fs::read_to_string(key).expect("fixture key"),
            passphrase: None,
        },
        HostKeyPolicy::pinned(options.host_key_fingerprints.clone()),
    )
}

fn only_session(config: &SshExecConfig) -> RemoteCatalogSession {
    let sessions = list_sessions_over_ssh(config.clone(), TIMEOUT).expect("catalog over SSH");
    let mut matching: Vec<_> = sessions
        .into_iter()
        .filter(|session| session.session_id == SESSION)
        .collect();
    assert_eq!(matching.len(), 1, "exactly one session is cataloged");
    matching.remove(0)
}

fn fence_of(session: &RemoteCatalogSession) -> SessionFence {
    SessionFence {
        workspace_id: session.workspace_id.clone(),
        session_id: session.session_id.clone(),
        runner_principal: session.runner_principal.clone(),
        runner_instance: session.runner_instance.clone(),
        channel_epoch: session
            .channel_epoch
            .parse()
            .expect("numeric channel epoch"),
        host_instance_id: session.host_instance_id.clone(),
        terminal_epoch: session.terminal_epoch.clone(),
    }
}

/// One attachment: true when its first screen shows the marker. The observer is
/// detached either way, so every call is one complete attach and detach.
fn attachment_shows_marker(config: &SshExecConfig, fence: &SessionFence) -> bool {
    let mut observer =
        attach_observer_over_ssh(config.clone(), fence.clone(), None).expect("attach over SSH");
    let mut shown = false;
    for _ in 0..16 {
        match observer.read_event().expect("observer event") {
            Some(ObserverEvent::Snapshot(snapshot)) => {
                shown = snapshot
                    .repaint_bytes
                    .windows(MARKER.len())
                    .any(|window| window == MARKER);
                break;
            }
            Some(ObserverEvent::Exit(_)) | None => panic!("session ended while attached"),
            Some(_) => {}
        }
    }
    observer.detach().expect("detach");
    shown
}

#[test]
#[ignore = "requires the owned macos-ssh-host-smoke.mjs fixture"]
fn provisions_a_mac_and_keeps_a_managed_session_across_ssh_connections() {
    let path = std::env::var_os("DURE_QA_MACOS_SSH_HOST").expect("owned SSH fixture required");
    let fixture: Fixture = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let options = fixture.ssh;
    let resources = fixture.resource_dir.as_path();

    let identity = crate::ssh::exec_once(&options, "uname -sm; id -u").expect("probe account");
    let mut lines = identity.stdout.lines();
    assert_eq!(
        lines.next(),
        Some("Darwin arm64"),
        "the host really is a Mac"
    );
    assert_ne!(lines.next(), Some("0"), "the SSH user must not be root");

    let installed = ensure_from_resources(resources, &options).expect("install over SSH");
    assert_eq!(installed.target_triple, "aarch64-apple-darwin");
    assert_eq!(installed.outcome, ProvisionOutcome::Installed);
    assert!(installed
        .runtime()
        .executable()
        .as_str()
        .starts_with(&fixture.home));
    let repeated = ensure_from_resources(resources, &options).expect("repeat over SSH");
    assert_eq!(repeated.outcome, ProvisionOutcome::AlreadyCurrent);
    assert_eq!(repeated.build_id, installed.build_id);
    println!("Provisioned {} over SSH", installed.build_id);

    let session = crate::ssh::acquire(&options).expect("SSH session");
    let helper = crate::remote_git_checkout_helper::ensure_from_resources(resources, &session)
        .expect("checkout helper over SSH");
    assert!(helper.starts_with(&fixture.home));
    let host = RemoteCheckoutHost::with_helper(
        session,
        helper,
        installed.runtime().home().clone(),
        Some(installed.runtime().executable().clone()),
    );

    let request = ManagedCreateRequest::new(
        "macos-ssh-create",
        SESSION,
        WORKSPACE,
        "codex",
        PermissionMode::Default,
        fixture.home.as_str(),
        vec![
            "/bin/sh".into(),
            "-c".into(),
            "printf 'dure-macos-host-ready\\n'; exec sleep 600".into(),
        ],
        24,
        80,
    )
    .expect("managed request");
    let _: serde_json::Value = host
        .execute(CheckoutHostCommandV1::CreateManaged { request }, TIMEOUT)
        .expect("managed create through the helper");
    drop(host);

    // Every step below opens its own SSH connection, so the Host seen here has
    // already outlived the one that created it.
    let config = exec_config(&options);
    let created = only_session(&config);
    assert_eq!(created.lifecycle, RemoteSessionLifecycle::Ready);
    let fence = fence_of(&created);
    let deadline = Instant::now() + TIMEOUT;
    while !attachment_shows_marker(&config, &fence) {
        assert!(
            Instant::now() < deadline,
            "the provider output never reached the screen"
        );
        std::thread::sleep(Duration::from_millis(250));
    }
    println!("Attached to {SESSION} and detached");
    assert!(
        attachment_shows_marker(&config, &fence),
        "reattach keeps the screen"
    );
    let reattached = only_session(&config);
    assert_eq!(reattached.lifecycle, RemoteSessionLifecycle::Ready);
    assert_eq!(reattached.host_instance_id, created.host_instance_id);
    assert_eq!(reattached.terminal_epoch, created.terminal_epoch);
    println!("Reattached to the same Host generation");

    let stop = ManagedStopRequest::new("macos-ssh-stop", SESSION, WORKSPACE)
        .and_then(|request| {
            request.with_expected_fence(
                &fence.runner_principal,
                &fence.runner_instance,
                fence.channel_epoch,
                &fence.host_instance_id,
                &fence.terminal_epoch,
            )
        })
        .expect("stop request");
    stop_managed_over_ssh(config, stop, TIMEOUT).expect("stop over SSH");
    println!("macOS SSH host smoke: managed session stopped");
}
