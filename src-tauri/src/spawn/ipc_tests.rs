use super::*;

#[test]
fn commands_share_application_home_across_restarts() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    std::fs::write(root.join("owned-command-test"), b"spawn-ipc-v1").unwrap();
    for phase in ["create", "resume"] {
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "spawn::ipc_tests::command_process",
                "--ignored",
                "--nocapture",
            ])
            .env("DURE_QA_SPAWN_IPC_ROOT", &root)
            .env("DURE_QA_SPAWN_IPC_PHASE", phase)
            .env("HOME", &root)
            .env("USERPROFILE", &root)
            .env("DURE_HOME", root.join("application"))
            .env("HMUX_DISCOVERY_ROOT", root.join("discovery"))
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr),
        );
    }
    assert!(!root.join(".dure").exists());
}

#[test]
#[ignore = "child process entry point for the isolated command test"]
fn command_process() {
    let root = PathBuf::from(std::env::var_os("DURE_QA_SPAWN_IPC_ROOT").unwrap());
    assert_eq!(root.canonicalize().unwrap(), root);
    assert_eq!(
        std::fs::read(root.join("owned-command-test")).unwrap(),
        b"spawn-ipc-v1"
    );
    let app = tauri::test::mock_builder()
        .invoke_handler(tauri::generate_handler![
            spawn_saga_create,
            spawn_journal_append,
            spawn_receipt_get,
            spawn_receipt_find,
            spawn_receipts_list_running,
            crate::session_checkout::session_checkout_register_agent_v1,
            crate::session_checkout::session_checkout_close_agent_registration_v1,
        ])
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window = tauri::WebviewWindowBuilder::new(&app, "journal", Default::default())
        .build()
        .unwrap();
    let creating = std::env::var("DURE_QA_SPAWN_IPC_PHASE").unwrap() == "create";
    let request = json!({"kind": "agent_registration", "prompt": "private prompt"});
    let created = invoke(
        &window,
        "spawn_saga_create",
        json!({
            "request": request, "idempotencyKey": "registration-1"
        }),
    );
    assert_eq!(created["existing"], !creating);
    let receipt_id = created["receiptId"].as_str().unwrap();
    assert!(root
        .join("application/spawn")
        .join(format!("{receipt_id}.journal.jsonl"))
        .is_file());
    let registration = invoke(
        &window,
        "session_checkout_register_agent_v1",
        json!({
            "target": null,
            "request": {
                "registrationId": "registration-1",
                "agent": {
                    "agentId": "agent-1", "runtimeWorkspaceId": "workspace-1",
                    "providerId": "local-shell", "workingDirectory": root,
                    "displayName": "IPC registration"
                }
            }
        }),
    );
    if creating {
        invoke(
            &window,
            "spawn_journal_append",
            json!({
                "receiptId": receipt_id,
                "event": {"event": "step_succeeded", "step": "runtime_session", "detail": registration}
            }),
        );
    }
    let receipt = invoke(
        &window,
        "spawn_receipt_get",
        json!({"receiptId": receipt_id}),
    );
    assert_eq!(receipt["steps"][2]["detail"], registration);
    assert!(receipt["request"].get("prompt").is_none());
    assert!(receipt["request"]["promptDigest"]
        .as_str()
        .unwrap()
        .starts_with("sha256:"));
    assert_eq!(
        invoke(
            &window,
            "spawn_receipt_find",
            json!({"idempotencyKey": "registration-1"})
        ),
        receipt
    );
    assert_eq!(
        invoke(&window, "spawn_receipts_list_running", json!({})),
        json!([receipt])
    );
    if !creating {
        invoke(
            &window,
            "session_checkout_close_agent_registration_v1",
            json!({
                "binding": registration["binding"], "target": null
            }),
        );
        invoke(
            &window,
            "spawn_journal_append",
            json!({
                "receiptId": receipt_id, "event": {"event": "saga_finished", "state": "compensated"}
            }),
        );
        assert_eq!(
            invoke(&window, "spawn_receipts_list_running", json!({})),
            json!([])
        );
    }
}

fn invoke(
    window: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    command: &str,
    body: Value,
) -> Value {
    tauri::test::get_ipc_response(
        window,
        tauri::webview::InvokeRequest {
            cmd: command.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: tauri::ipc::InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.into(),
        },
    )
    .unwrap_or_else(|error| panic!("{command} failed: {error:?}"))
    .deserialize()
    .unwrap()
}
