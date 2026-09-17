use super::*;
use dure_session_runtime::{
    host_command::AgentCheckoutRegistrationRequestV1, AgentCheckoutRegistrationV1,
};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    ssh: ssh::SshOptions,
    checkout: String,
}

#[test]
#[ignore = "requires the owned checkout-registration-ssh-smoke.mjs Tauri fixture"]
fn ssh_registration_upload_and_cancel_without_a_runtime() {
    let path =
        std::env::var_os("DURE_QA_CHECKOUT_SSH_FIXTURE").expect("owned SSH fixture required");
    let fixture: Fixture = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(fixture.ssh.host, "127.0.0.1");
    assert_eq!(fixture.ssh.auth.as_deref(), Some("key"));
    assert!(!fixture.ssh.host_key_fingerprints.is_empty());
    assert!(fixture
        .checkout
        .starts_with("/tmp/dure-checkout-ssh.fixture/tauri/"));
    let app = tauri::test::mock_builder()
        .invoke_handler(tauri::generate_handler![
            crate::session_checkout::session_checkout_register_agent_v1,
            crate::session_checkout::session_checkout_close_agent_registration_v1
        ])
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window = tauri::WebviewWindowBuilder::new(&app, "ssh-checkout", Default::default())
        .build()
        .unwrap();
    let target = json!({
        "hostId": "checkout-qa", "host": fixture.ssh.host, "port": fixture.ssh.port.unwrap(),
        "user": fixture.ssh.user, "auth": "key", "keyPath": fixture.ssh.key_path,
        "hostKeyFingerprints": fixture.ssh.host_key_fingerprints,
    });
    let prepare = || RemoteCheckoutHost::prepare_registration(app.handle(), fixture.ssh.clone());
    let host = prepare().expect("registration must not require an installed runtime");
    assert!(host.context.runtime_executable.is_none());
    let request: AgentCheckoutRegistrationRequestV1 = serde_json::from_value(serde_json::json!({
        "registrationId": "tauri-ssh-incarnation",
        "agent": {
            "agentId": "tauri-ssh-agent", "runtimeWorkspaceId": "tauri-ssh-workspace",
            "providerId": "local-shell", "workingDirectory": fixture.checkout,
            "displayName": "Tauri SSH registration fixture"
        }
    }))
    .unwrap();
    let register = CheckoutHostCommandV1::RegisterAgent {
        request: request.clone(),
    };
    let timeout = Duration::from_secs(30);
    let repository = format!(
        "{}/repository",
        fixture.checkout.rsplit_once('/').unwrap().0
    );
    let capture = git_command(
        &host,
        "capture-v1",
        json!({
            "repositoryPath": repository, "checkoutPath": fixture.checkout,
        }),
    )
    .unwrap();
    let removal =
        json!({"repositoryPath": repository, "instance": capture, "policy": "require_clean"});
    let first: AgentCheckoutRegistrationV1 = host.execute(register.clone(), timeout).unwrap();
    assert!(
        matches!(git_command(&host, "remove-v1", removal.clone()), Err(HelperCallErrorV1::Reported(error)) if error.code == "checkout_use_in_use")
    );
    drop(host);
    assert_eq!(
        invoke(
            &window,
            "session_checkout_register_agent_v1",
            json!({
                "request": request, "target": target,
            })
        ),
        serde_json::to_value(&first).unwrap()
    );
    assert_eq!(
        invoke(
            &window,
            "session_checkout_close_agent_registration_v1",
            json!({
                "binding": first.binding, "target": target,
            })
        ),
        Value::Null
    );
    let cancel = CheckoutHostCommandV1::CloseAgentRegistration {
        binding: first.binding,
    };
    let closed = prepare().unwrap();
    closed.execute::<()>(cancel.clone(), timeout).unwrap();
    assert!(matches!(
        closed.execute::<AgentCheckoutRegistrationV1>(register, timeout),
        Err(HelperCallErrorV1::Reported(_))
    ));
    // Even an installed but unusable runtime must remain idle during metadata
    // cancellation. These paths exist only inside the runner's disposable VM.
    let marker = format!(
        "{}/runtime-was-executed",
        fixture.checkout.rsplit_once('/').unwrap().0
    );
    let executable = format!(
        "{}/.local/bin/hmux-runtime",
        closed.context.user_home.display()
    );
    let install = format!(
        "set -eu; mkdir -p -- {directory}; printf '%s\\n' '#!/bin/sh' {body} > {executable}; chmod 700 -- {executable}",
        directory = ssh::shell_quote(&format!("{}/.local/bin", closed.context.user_home.display())),
        body = ssh::shell_quote(&format!("touch {}; exit 91", ssh::shell_quote(&marker))),
        executable = ssh::shell_quote(&executable),
    );
    assert_eq!(ssh::exec_on(&closed.session, &install).unwrap().code, 0);
    let installed = prepare().unwrap();
    assert_eq!(
        installed
            .context
            .runtime_executable
            .as_ref()
            .unwrap()
            .to_str(),
        Some(executable.as_str())
    );
    installed.execute::<()>(cancel, timeout).unwrap();
    assert_eq!(
        ssh::exec_on(
            &installed.session,
            &format!(
                "test ! -e {} && rm -- {}",
                ssh::shell_quote(&marker),
                ssh::shell_quote(&executable),
            )
        )
        .unwrap()
        .code,
        0
    );
    assert_eq!(
        git_command(&closed, "remove-v1", removal).unwrap()["outcome"],
        "removed"
    );
}

#[test]
#[ignore = "requires the owned checkout-registration-ssh-smoke.mjs Tauri fixture"]
fn ssh_managed_lifecycle_owns_checkout_until_resource_removal() {
    let path =
        std::env::var_os("DURE_QA_CHECKOUT_SSH_FIXTURE").expect("owned SSH fixture required");
    let fixture: Fixture = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(fixture.ssh.host, "127.0.0.1");
    assert!(fixture
        .checkout
        .starts_with("/tmp/dure-checkout-ssh.fixture/tauri/"));
    let root = fixture.checkout.rsplit_once('/').unwrap().0;
    let app = tauri::test::mock_builder()
        .invoke_handler(tauri::generate_handler![
            crate::session_checkout::session_checkout_register_agent_v1,
            crate::session_checkout::session_checkout_close_agent_registration_v1,
            crate::session_checkout::session_checkout_reconcile_managed_close_v1,
            crate::remote_hmux::remote_hmux_managed_create,
            crate::remote_hmux::remote_hmux_managed_create_advance_v1,
            crate::remote_hmux::remote_hmux_managed_create_chain_stop_v1,
            crate::remote_hmux::remote_hmux_managed_create_chain_stop_v2,
        ])
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window = tauri::WebviewWindowBuilder::new(&app, "ssh-lifecycle", Default::default())
        .build()
        .unwrap();
    let target = json!({
        "hostId": "checkout-qa", "host": fixture.ssh.host, "port": fixture.ssh.port.unwrap(),
        "user": fixture.ssh.user, "auth": "key", "keyPath": fixture.ssh.key_path,
        "hostKeyFingerprints": fixture.ssh.host_key_fingerprints,
    });
    for scenario in ["plain", "registered"] {
        let checkout = format!("{root}/{scenario}");
        let host =
            RemoteCheckoutHost::prepare_registration(app.handle(), fixture.ssh.clone()).unwrap();
        let capture = git_command(
            &host,
            "capture-v1",
            json!({
                "repositoryPath": format!("{root}/repository"), "checkoutPath": checkout,
            }),
        )
        .unwrap();
        let removal = json!({
            "repositoryPath": format!("{root}/repository"), "instance": capture,
            "policy": "require_clean",
        });
        let registration = (scenario == "registered").then(|| {
            invoke(
                &window,
                "session_checkout_register_agent_v1",
                json!({
                    "target": target,
                    "request": {
                        "registrationId": "native-incarnation", "agent": {
                            "agentId": "native-agent", "runtimeWorkspaceId": "native-workspace",
                            "providerId": "claude", "workingDirectory": checkout,
                            "displayName": "Disposable shell provider"
                        }
                    }
                }),
            )
        });
        let native_root = registration
            .as_ref()
            .map(|value| value["root"].clone())
            .unwrap_or_else(|| {
                json!({
                    "idempotencyKey": "native-plain-create", "sessionId": "native-plain-session",
                    "workspaceId": "native-plain-workspace",
                })
            });
        let request = json!({
            "target": target, "idempotencyKey": native_root["idempotencyKey"],
            "sessionId": native_root["sessionId"], "workspaceId": native_root["workspaceId"],
            "providerId": "claude", "permissionMode": "default", "bridgeNonce": "native-bridge",
            "cwd": checkout, "initialRows": 24, "initialColumns": 80,
        });
        let created = invoke(
            &window,
            "remote_hmux_managed_create",
            json!({"request": request}),
        );
        assert_eq!(created["session"]["lifecycle"], "ready");
        let replay = invoke(
            &window,
            "remote_hmux_managed_create",
            json!({"request": request}),
        );
        assert_eq!(
            replay["session"], created["session"],
            "create replay replaced the native generation"
        );
        let current = invoke(
            &window,
            "remote_hmux_managed_create_advance_v1",
            json!({"request": request}),
        );
        assert_eq!(current["state"], "current");
        assert_eq!(current["receipt"]["session"], created["session"]);
        let close_identity = hmux_client::ManagedCreateReconcileRequest::new(
            native_root["idempotencyKey"].as_str().unwrap(),
            native_root["sessionId"].as_str().unwrap(),
            native_root["workspaceId"].as_str().unwrap(),
        )
        .unwrap();
        assert_eq!(
            invoke(
                &window,
                "session_checkout_reconcile_managed_close_v1",
                json!({"target": target, "request": close_identity}),
            ),
            Value::Null,
            "observing an unfinished close must not stop a running generation"
        );
        assert!(
            matches!(git_command(&host, "remove-v1", removal.clone()),
                Err(HelperCallErrorV1::Reported(error)) if error.code == "checkout_use_in_use"
            ),
            "a native SSH session must own its checkout before provider stop"
        );

        let mut active = created["session"].clone();
        if scenario == "plain" {
            // End only this disposable cat through exact-generation native input.
            // The provider's natural exit, not a product Remove, allows advancement.
            let fence = json!({
                "workspace_id": active["workspaceId"], "session_id": active["sessionId"],
                "runner_principal": active["runnerPrincipal"], "runner_instance": active["runnerInstance"],
                "channel_epoch": active["channelEpoch"], "host_instance_id": active["hostInstanceId"],
                "terminal_epoch": active["terminalEpoch"],
            });
            let sent = ssh::exec_on(&host.session, &format!(
                "\"$HOME/.local/bin/hmux\" --json send-keys --target {} --workspace {} --expected-fence-json {} C-d",
                ssh::shell_quote(active["sessionId"].as_str().unwrap()),
                ssh::shell_quote(active["workspaceId"].as_str().unwrap()),
                ssh::shell_quote(&fence.to_string()),
            )).unwrap();
            assert_eq!(sent.code, 0, "{}{}", sent.stdout, sent.stderr);
            let deadline = std::time::Instant::now() + Duration::from_secs(20);
            loop {
                if !native_sessions(&host).iter().any(|session| {
                    session.session_id == active["sessionId"].as_str().unwrap()
                        && session.lifecycle == hmux_client::SessionLifecycle::Ready
                }) {
                    break;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "fixture provider did not exit"
                );
                std::thread::sleep(Duration::from_millis(50));
            }
            let advanced = invoke(
                &window,
                "remote_hmux_managed_create_advance_v1",
                json!({"request": request}),
            );
            assert_eq!(advanced["state"], "advanced", "{advanced}");
            active = advanced["receipt"]["session"].clone();
            assert_ne!(active["sessionId"], native_root["sessionId"]);
            assert_eq!(active["lifecycle"], "ready");
            assert!(
                matches!(git_command(&host, "remove-v1", removal.clone()),
                    Err(HelperCallErrorV1::Reported(error)) if error.code == "checkout_use_in_use"
                ),
                "advancement released a live successor's checkout"
            );
        }
        let before_stop = native_sessions(&host)
            .into_iter()
            .find(|session| session.session_id == active["sessionId"].as_str().unwrap())
            .unwrap();
        assert_eq!(before_stop.lifecycle, hmux_client::SessionLifecycle::Ready);
        let stop = json!({
            "target": target, "idempotencyKey": native_root["idempotencyKey"],
            "sessionId": native_root["sessionId"], "workspaceId": native_root["workspaceId"],
        });
        let stopped = invoke(
            &window,
            "remote_hmux_managed_create_chain_stop_v2",
            json!({"request": stop}),
        );
        let receipt: hmux_client::ManagedCreateChainStopReceiptV2 =
            serde_json::from_value(stopped.clone()).unwrap();
        receipt.validate().unwrap();
        assert_eq!(
            receipt.chain().len(),
            if scenario == "plain" { 2 } else { 1 }
        );
        assert_eq!(receipt.root().session_id(), native_root["sessionId"]);
        assert_eq!(receipt.effective().session_id(), before_stop.session_id);
        assert_eq!(
            receipt.stop_receipt().unwrap().terminal_epoch(),
            before_stop.terminal_epoch
        );
        for identity in [&close_identity, receipt.effective()] {
            assert_eq!(
                invoke(
                    &window,
                    "session_checkout_reconcile_managed_close_v1",
                    json!({"target": target, "request": identity}),
                ),
                stopped,
                "a fresh SSH helper must replay the same complete lineage receipt"
            );
        }
        assert_eq!(
            invoke(
                &window,
                "remote_hmux_managed_create_chain_stop_v2",
                json!({"request": stop})
            ),
            stopped
        );
        invoke(
            &window,
            "remote_hmux_managed_create_chain_stop_v1",
            json!({"request": stop}),
        );
        // Stop retains the exited manifest for history; it does not erase it.
        // Observe the exact generation's terminal lifecycle, not catalog absence.
        let after_stop = native_sessions(&host)
            .into_iter()
            .find(|session| session.session_id == before_stop.session_id)
            .unwrap();
        assert!(after_stop.same_generation(&before_stop));
        assert_eq!(after_stop.lifecycle, hmux_client::SessionLifecycle::Exited);
        assert!(!after_stop.process_session_cleanup_incomplete());
        if let Some(registration) = registration {
            assert!(
                matches!(git_command(&host, "remove-v1", removal.clone()),
                    Err(HelperCallErrorV1::Reported(error)) if error.code == "checkout_use_in_use"
                ),
                "ordinary Stop must retain Agent registration ownership"
            );
            invoke(
                &window,
                "session_checkout_close_agent_registration_v1",
                json!({
                    "target": target, "binding": registration["binding"],
                }),
            );
        }
        assert_eq!(
            git_command(&host, "remove-v1", removal).unwrap()["outcome"],
            "removed"
        );
        assert_eq!(
            ssh::exec_on(
                &host.session,
                &format!("test ! -e {}", ssh::shell_quote(&checkout))
            )
            .unwrap()
            .code,
            0
        );
        eprintln!("Native SSH lifecycle passed: {scenario}");
    }
}

fn native_sessions(host: &RemoteCheckoutHost) -> Vec<hmux_client::SessionDescriptor> {
    let result = ssh::exec_on(&host.session, "\"$HOME/.local/bin/hmux\" --json ls").unwrap();
    assert_eq!(result.code, 0, "{}", result.stderr);
    serde_json::from_str(&result.stdout).unwrap()
}

fn invoke(
    window: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    command: &str,
    body: Value,
) -> Value {
    let webview: &tauri::Webview<tauri::test::MockRuntime> = window.as_ref();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview.clone().on_message(
        tauri::webview::InvokeRequest {
            cmd: command.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: tauri::ipc::InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.into(),
        },
        Box::new(move |_, _, response, _, _| {
            let _ = sender.send(response);
        }),
    );
    match receiver
        .recv_timeout(Duration::from_secs(120))
        .expect("SSH IPC must reply")
    {
        tauri::ipc::InvokeResponse::Ok(body) => body.deserialize().unwrap(),
        tauri::ipc::InvokeResponse::Err(error) => panic!("{command} failed: {error:?}"),
    }
}

fn git_command(
    host: &RemoteCheckoutHost,
    operation: &str,
    request: Value,
) -> Result<Value, HelperCallErrorV1> {
    let result = ssh::exec_on_with_stdin_timeout(
        &host.session,
        &format!("{} {operation}", ssh::shell_quote(&host.helper)),
        Some(&request.to_string()),
        Duration::from_secs(30),
    )
    .map_err(HelperCallErrorV1::OutcomeUnknown)?;
    decode_helper_response(result.code, result.stdout.as_bytes())
}
