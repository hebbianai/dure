use dure_git_checkout::{
    GitCheckoutCaptureRequestV1, GitCheckoutInstanceError, GitCheckoutRemovalRequestV1,
};
use dure_session_runtime::host_command::{
    CheckoutHostRequestV1, HELPER_OPERATIONS, HELPER_PROTOCOL as PROTOCOL,
    HelperErrorV1 as HelperError, HelperResponseV1,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::io::{Read, Write};

const SCHEMA_VERSION: u8 = 1;
const MAX_INPUT_BYTES: u64 = 8 * 1024 * 1024;
const MAX_ERROR_MESSAGE_BYTES: usize = 4 * 1024;
const AUTHORITY_ERROR_EXIT: i32 = 50;
const REQUEST_ERROR_EXIT: i32 = 64;
const INTERNAL_ERROR_EXIT: i32 = 70;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Capabilities {
    protocol: &'static str,
    operations: [&'static str; 4],
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocationsRequest {
    schema_version: u8,
    paths: Vec<String>,
}

fn bounded_message(mut message: String) -> String {
    if message.len() <= MAX_ERROR_MESSAGE_BYTES {
        return message;
    }
    let mut end = MAX_ERROR_MESSAGE_BYTES;
    while !message.is_char_boundary(end) {
        end -= 1;
    }
    message.truncate(end);
    message
}

fn request_error(message: impl Into<String>) -> HelperError {
    HelperError {
        code: "worktree_request_invalid".to_string(),
        message: bounded_message(message.into()),
    }
}

fn authority_error(error: GitCheckoutInstanceError) -> HelperError {
    HelperError {
        code: error.code.to_string(),
        message: bounded_message(error.message),
    }
}

fn read_request<T: DeserializeOwned>(input: &mut impl Read) -> Result<T, HelperError> {
    let mut bytes = Vec::new();
    input
        .take(MAX_INPUT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| request_error(format!("could not read request: {error}")))?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_INPUT_BYTES {
        return Err(request_error(
            "request is empty or exceeds the bounded size",
        ));
    }
    serde_json::from_slice(&bytes)
        .map_err(|error| request_error(format!("request is not valid JSON: {error}")))
}

fn write_json(output: &mut impl Write, value: &impl Serialize) -> Result<(), ()> {
    serde_json::to_writer(&mut *output, value).map_err(|_| ())?;
    output.write_all(b"\n").map_err(|_| ())
}

fn write_success(output: &mut impl Write, value: impl Serialize) -> i32 {
    if write_json(
        output,
        &HelperResponseV1::Success {
            schema_version: SCHEMA_VERSION,
            value,
        },
    )
    .is_ok()
    {
        0
    } else {
        INTERNAL_ERROR_EXIT
    }
}

fn write_failure(output: &mut impl Write, error: HelperError, exit: i32) -> i32 {
    if write_json(
        output,
        &HelperResponseV1::<()>::Failure {
            schema_version: SCHEMA_VERSION,
            error,
        },
    )
    .is_ok()
    {
        exit
    } else {
        INTERNAL_ERROR_EXIT
    }
}

fn execute(command: &str, input: &mut impl Read, output: &mut impl Write) -> i32 {
    match command {
        "capabilities-v1" => write_success(
            output,
            Capabilities {
                protocol: PROTOCOL,
                operations: HELPER_OPERATIONS,
            },
        ),
        "capture-v1" => {
            let request = match read_request::<GitCheckoutCaptureRequestV1>(input) {
                Ok(request) => request,
                Err(error) => return write_failure(output, error, REQUEST_ERROR_EXIT),
            };
            match dure_git_checkout::capture_git_checkout_instance(&request) {
                Ok(receipt) => write_success(output, receipt),
                Err(error) => write_failure(output, authority_error(error), AUTHORITY_ERROR_EXIT),
            }
        }
        "locations-v1" => {
            let request = match read_request::<LocationsRequest>(input) {
                Ok(request) if request.schema_version == SCHEMA_VERSION => request,
                Ok(_) => {
                    return write_failure(
                        output,
                        request_error("unsupported request schema"),
                        REQUEST_ERROR_EXIT,
                    );
                }
                Err(error) => return write_failure(output, error, REQUEST_ERROR_EXIT),
            };
            match dure_git_checkout::locate_checkouts(&request.paths) {
                Ok(receipt) => write_success(output, receipt),
                Err(error) => write_failure(output, authority_error(error), AUTHORITY_ERROR_EXIT),
            }
        }
        "remove-v1" => {
            let request = match read_request::<GitCheckoutRemovalRequestV1>(input) {
                Ok(request) => request,
                Err(error) => return write_failure(output, error, REQUEST_ERROR_EXIT),
            };
            match dure_git_checkout::remove_git_checkout_instance(&request) {
                Ok(receipt) => write_success(output, receipt),
                Err(error) => write_failure(output, authority_error(error), AUTHORITY_ERROR_EXIT),
            }
        }
        "session-v1" => {
            let request = match read_request::<CheckoutHostRequestV1>(input) {
                Ok(request) => request,
                Err(error) => return write_failure(output, error, REQUEST_ERROR_EXIT),
            };
            let result = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|error| error.to_string())
                .and_then(|runtime| runtime.block_on(request.execute()));
            match result {
                Ok(receipt) => write_success(output, receipt),
                Err(message) => write_failure(
                    output,
                    HelperError {
                        code: "session_checkout_failed".into(),
                        message: bounded_message(message),
                    },
                    AUTHORITY_ERROR_EXIT,
                ),
            }
        }
        _ => REQUEST_ERROR_EXIT,
    }
}

fn main() {
    let mut arguments = std::env::args();
    let _program = arguments.next();
    let Some(command) = arguments.next() else {
        std::process::exit(REQUEST_ERROR_EXIT);
    };
    if arguments.next().is_some() {
        std::process::exit(REQUEST_ERROR_EXIT);
    }
    std::process::exit(execute(
        &command,
        &mut std::io::stdin().lock(),
        &mut std::io::stdout().lock(),
    ));
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::io::Cursor;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    fn invoke(command: &str, input: &[u8]) -> (i32, Value) {
        let mut output = Vec::new();
        let exit = execute(command, &mut Cursor::new(input), &mut output);
        let value = serde_json::from_slice(&output).expect("one JSON response");
        (exit, value)
    }

    fn git(directory: &Path, arguments: &[&str]) {
        let mut command = Command::new("git");
        command
            .arg("-c")
            .arg("core.hooksPath=/dev/null")
            .arg("-c")
            .arg("commit.gpgsign=false")
            .args(arguments)
            .current_dir(directory);
        for (name, _) in std::env::vars_os() {
            if name.to_string_lossy().starts_with("GIT_") {
                command.env_remove(name);
            }
        }
        let status = command.status().expect("git must start");
        assert!(status.success(), "git {arguments:?} failed");
    }

    #[test]
    fn reports_one_exact_capability_contract() {
        let (exit, response) = invoke("capabilities-v1", b"");
        assert_eq!(exit, 0);
        assert_eq!(response["schemaVersion"], 1);
        assert_eq!(response["value"]["protocol"], "dure-git-checkout-helper-v2");
        assert_eq!(
            response["value"]["operations"],
            serde_json::json!(HELPER_OPERATIONS)
        );
    }

    #[test]
    fn rejects_malformed_and_overbound_input_before_dispatch() {
        let (malformed_exit, malformed) = invoke("capture-v1", b"not-json");
        assert_eq!(malformed_exit, REQUEST_ERROR_EXIT);
        assert_eq!(malformed["error"]["code"], "worktree_request_invalid");

        let relative = serde_json::json!({
            "repositoryPath": "/repository",
            "checkoutPath": "relative"
        });
        let (relative_exit, relative) = invoke(
            "capture-v1",
            serde_json::to_string(&relative).unwrap().as_bytes(),
        );
        assert_eq!(relative_exit, AUTHORITY_ERROR_EXIT);
        assert_eq!(relative["error"]["code"], "worktree_request_invalid");

        let oversized = vec![b'x'; MAX_INPUT_BYTES as usize + 1];
        let (oversized_exit, oversized) = invoke("capture-v1", &oversized);
        assert_eq!(oversized_exit, REQUEST_ERROR_EXIT);
        assert_eq!(oversized["error"]["code"], "worktree_request_invalid");
    }

    #[test]
    fn bounds_multibyte_error_messages_without_splitting_utf8() {
        let bounded = bounded_message("가".repeat(MAX_ERROR_MESSAGE_BYTES));
        assert!(bounded.len() <= MAX_ERROR_MESSAGE_BYTES);
        assert!(!bounded.is_empty());
    }

    #[test]
    fn ssh_decoder_consumes_the_executables_receipts_without_losing_failure() {
        use dure_session_runtime::host_command::decode_helper_response;

        let mut output = Vec::new();
        let code = write_success(&mut output, "receipt");
        assert_eq!(
            decode_helper_response::<String>(code, &output).unwrap(),
            "receipt"
        );

        output.clear();
        let code = write_success(&mut output, ());
        decode_helper_response::<()>(code, &output).unwrap();
        assert!(
            decode_helper_response::<()>(1, &output)
                .unwrap_err()
                .to_string()
                .contains("outcome_unknown")
        );

        output.clear();
        let code = write_failure(
            &mut output,
            HelperError {
                code: "closed".into(),
                message: "retained".into(),
            },
            AUTHORITY_ERROR_EXIT,
        );
        assert_eq!(
            decode_helper_response::<()>(code, &output)
                .unwrap_err()
                .to_string(),
            "closed: retained"
        );
        assert!(
            decode_helper_response::<()>(0, &output)
                .unwrap_err()
                .to_string()
                .contains("outcome_unknown")
        );

        for response in [
            b"".as_slice(),
            br#"{"schemaVersion":2,"value":null}"#,
            br#"{"schemaVersion":1,"value":null,"error":{"code":"closed","message":"retained"}}"#,
        ] {
            assert!(
                decode_helper_response::<()>(0, response)
                    .unwrap_err()
                    .to_string()
                    .contains("outcome_unknown")
            );
        }
    }

    fn checkout_fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let canonical = root.path().canonicalize().unwrap();
        let repository = canonical.join("repository");
        let checkout = canonical.join("checkout");
        std::fs::create_dir(&repository).unwrap();
        git(&repository, &["init"]);
        git(
            &repository,
            &["config", "user.email", "test@example.invalid"],
        );
        git(&repository, &["config", "user.name", "Dure Test"]);
        std::fs::write(repository.join("tracked"), "content\n").unwrap();
        git(&repository, &["add", "tracked"]);
        git(&repository, &["commit", "-m", "fixture"]);
        git(
            &repository,
            &[
                "worktree",
                "add",
                "-b",
                "helper-fixture",
                checkout.to_str().unwrap(),
            ],
        );
        (root, repository, checkout)
    }

    #[test]
    fn dispatches_confirmed_dirty_removal_through_the_canonical_engine() {
        let (_root, repository, checkout) = checkout_fixture();

        let capture_request = serde_json::json!({
            "repositoryPath": repository,
            "checkoutPath": checkout,
        });
        let (capture_exit, capture) = invoke(
            "capture-v1",
            serde_json::to_string(&capture_request).unwrap().as_bytes(),
        );
        assert_eq!(capture_exit, 0);
        std::fs::write(checkout.join("uncommitted"), "discard me\n").unwrap();

        let remove_request = serde_json::json!({
            "repositoryPath": repository,
            "instance": capture["value"].clone(),
            "policy": "discard_changes",
        });
        let (remove_exit, removal) = invoke(
            "remove-v1",
            serde_json::to_string(&remove_request).unwrap().as_bytes(),
        );
        assert_eq!(remove_exit, 0);
        assert_eq!(removal["value"]["outcome"], "removed");
        assert!(!checkout.exists());
    }

    fn registration_request(root: &Path, checkout: &Path) -> Value {
        let canonical = root.canonicalize().unwrap();
        let context = serde_json::json!({
            "applicationHome": canonical.join("app"),
            "userHome": canonical.join("unused-home"),
            "runtimeExecutable": canonical.join("unused-runtime"),
            "discoveryRoot": canonical.join("discovery"),
        });
        serde_json::json!({
            "context": context,
            "command": {
                "kind": "register_agent",
                "request": {
                    "registrationId": "incarnation-one",
                    "agent": {
                        "agentId": "helper-agent",
                        "runtimeWorkspaceId": "helper-workspace",
                        "providerId": "local-shell",
                        "workingDirectory": checkout,
                        "displayName": "Helper fixture"
                    }
                }
            }
        })
    }

    #[test]
    fn completed_close_replays_across_helper_reopens_without_a_runtime() {
        use dure_app::{
            SessionCheckoutAdmissionV1, SessionCheckoutBindingV1, SessionCheckoutIdentityV1,
            SessionCheckoutOwnerV1,
        };
        use dure_session_runtime::host_command::{decode_helper_response, open_application_store};
        use hmux_client::recovery_journal::managed_create_ledger::{
            ManagedCreateLedgerState, ManagedCreateLineageAdmission, checkpoint_retirement_exact,
            claim_successor_chain_cleanup, finalize_retirement_exact, reserve_request,
        };
        use hmux_client::{
            ManagedCreateChainStopReceiptV2, ManagedCreateGenerationFence, ManagedCreateOutcome,
            ManagedCreateReceipt, ManagedCreateReconcileRequest, ManagedCreateRequest,
            ManagedStopOutcome, ManagedStopReceipt, ManagedStopRequest, PermissionMode,
            ProcessDescriptor,
        };

        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let discovery = root.join("discovery");
        let application_home = root.join("app");
        let identity =
            ManagedCreateReconcileRequest::new("create", "session", "workspace").unwrap();
        let request = serde_json::json!({
            "context": {
                "applicationHome": application_home, "userHome": root.join("unused-home"),
                "discoveryRoot": discovery,
            },
            "command": {"kind": "reconcile_managed_close", "request": identity},
        });
        let encoded = serde_json::to_vec(&request).unwrap();
        let query = || {
            let mut output = Vec::new();
            let code = execute("session-v1", &mut Cursor::new(&encoded), &mut output);
            decode_helper_response::<Option<ManagedCreateChainStopReceiptV2>>(code, &output)
                .unwrap()
        };
        let binding = SessionCheckoutBindingV1::new(
            SessionCheckoutIdentityV1 {
                runtime_namespace: discovery.to_str().unwrap().into(),
                owner: SessionCheckoutOwnerV1::Managed {
                    idempotency_key: identity.idempotency_key().into(),
                    session_id: identity.session_id().into(),
                    workspace_id: identity.workspace_id().into(),
                },
            },
            root.to_str().unwrap().into(),
            None,
        );
        let executor = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        executor.block_on(async {
            let store = open_application_store(&application_home).await.unwrap();
            store
                .prepare_session_checkout_with(&binding, || async {
                    Ok::<_, dure_app::DomainStoreErrorV1>(())
                })
                .await
                .unwrap();
            store.close().await;
        });
        let admission = || {
            executor.block_on(async {
                let store = open_application_store(&application_home).await.unwrap();
                let admission = store
                    .session_checkout(&binding.identity)
                    .await
                    .unwrap()
                    .unwrap()
                    .admission;
                store.close().await;
                admission
            })
        };
        assert_eq!(query(), None);
        assert_eq!(admission(), SessionCheckoutAdmissionV1::Open);
        assert!(!discovery.exists());

        // Drive the real durable ledger with fixture receipts, not a provider.
        std::fs::create_dir(&discovery).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&discovery, std::fs::Permissions::from_mode(0o700))
                .unwrap();
        }
        let create = ManagedCreateRequest::new(
            "create",
            "session",
            "workspace",
            "local-shell",
            PermissionMode::Default,
            &root,
            vec!["unused-provider".into()],
            24,
            80,
        )
        .unwrap();
        let ManagedCreateLedgerState::Prepared(mut reservation) =
            reserve_request(&discovery, &create, ManagedCreateLineageAdmission::Root).unwrap()
        else {
            panic!("fixture create must be prepared")
        };
        reservation.checkpoint_pre_spawn_absence().unwrap();
        reservation
            .mark_spawn_reserved(ProcessDescriptor {
                process_id: 101,
                start_marker: "fixture-only-generation".into(),
            })
            .unwrap();
        reservation.release_with_barrier_proof().unwrap();
        let created = ManagedCreateReceipt::new(
            "create",
            "session",
            "workspace",
            "local-shell",
            PermissionMode::Default,
            &root,
            ManagedCreateOutcome::Created,
        )
        .unwrap()
        .with_generation_fence(
            ManagedCreateGenerationFence::new("principal", "runner", 1, "host", "epoch").unwrap(),
        )
        .unwrap();
        reservation
            .complete(serde_json::to_string(&created).unwrap())
            .unwrap();
        drop(reservation);
        assert_eq!(query(), None);
        assert_eq!(admission(), SessionCheckoutAdmissionV1::Open);

        let stop = ManagedStopReceipt::from_request(
            &ManagedStopRequest::new("stop", "session", "workspace")
                .unwrap()
                .with_expected_fence("principal", "runner", 1, "host", "epoch")
                .unwrap(),
            ManagedStopOutcome::Stopped,
            "managed_provider_stopped",
        )
        .unwrap();
        claim_successor_chain_cleanup(&discovery, &identity).unwrap();
        checkpoint_retirement_exact(&discovery, &stop).unwrap();
        assert_eq!(query(), None);
        assert_eq!(admission(), SessionCheckoutAdmissionV1::Open);
        finalize_retirement_exact(&discovery, &stop).unwrap();

        let completed = query().unwrap();
        assert_eq!(completed.chain(), std::slice::from_ref(&identity));
        assert_eq!(completed.stop_receipt(), Some(&stop));
        assert_eq!(admission(), SessionCheckoutAdmissionV1::Closed);
        assert_eq!(query(), Some(completed));
        assert_eq!(admission(), SessionCheckoutAdmissionV1::Closed);

        let mut wrong = request;
        wrong["command"]["request"]["idempotencyKey"] = "another-create".into();
        let (code, response) = invoke("session-v1", &serde_json::to_vec(&wrong).unwrap());
        assert_eq!(code, AUTHORITY_ERROR_EXIT, "{response}");
        assert!(response.get("value").is_none());
        assert_eq!(admission(), SessionCheckoutAdmissionV1::Closed);
    }

    #[test]
    fn helper_registration_replay_and_own_only_cancel_share_git_membership() {
        let (root, repository, checkout) = checkout_fixture();
        let registration = registration_request(root.path(), &checkout);
        let encoded = serde_json::to_vec(&registration).unwrap();
        let (exit, first) = invoke("session-v1", &encoded);
        assert_eq!(exit, 0, "{first}");
        let (exit, replay) = invoke("session-v1", &encoded);
        assert_eq!(exit, 0, "{replay}");
        assert_eq!(first, replay);
        let checkout_registration = dure_git_checkout::capture_git_checkout_registration(&checkout)
            .unwrap()
            .unwrap();
        assert_eq!(
            dure_git_checkout::read_git_checkout_claims(&checkout_registration)
                .unwrap()
                .len(),
            1
        );

        let removal = serde_json::json!({
            "repositoryPath": repository,
            "instance": checkout_registration.instance,
            "policy": "require_clean",
        });
        let encoded_removal = serde_json::to_vec(&removal).unwrap();
        let (exit, refused) = invoke("remove-v1", &encoded_removal);
        assert_eq!(exit, AUTHORITY_ERROR_EXIT);
        assert_eq!(refused["error"]["code"], "checkout_use_in_use");
        assert!(
            checkout.exists(),
            "a prior Agent claim must retain the checkout"
        );

        let mut newcomer = registration;
        newcomer["command"]["request"]["registrationId"] = "another-incarnation".into();
        let (exit, _) = invoke("session-v1", &serde_json::to_vec(&newcomer).unwrap());
        assert_eq!(exit, AUTHORITY_ERROR_EXIT);
        assert_eq!(
            dure_git_checkout::read_git_checkout_claims(&checkout_registration)
                .unwrap()
                .len(),
            1
        );

        let cancel = serde_json::json!({
            "context": newcomer["context"],
            "command": {"kind": "close_agent_registration", "binding": first["value"]["binding"]}
        });
        let (exit, closed) = invoke("session-v1", &serde_json::to_vec(&cancel).unwrap());
        assert_eq!(exit, 0, "{closed}");
        assert!(closed["value"].is_null());
        assert!(
            dure_git_checkout::read_git_checkout_claims(&checkout_registration)
                .unwrap()
                .is_empty()
        );
        let (exit, _) = invoke("session-v1", &encoded);
        assert_eq!(
            exit, AUTHORITY_ERROR_EXIT,
            "cancelled registration must not reopen"
        );
        let (exit, removed) = invoke("remove-v1", &encoded_removal);
        assert_eq!(exit, 0, "{removed}");
        assert!(!checkout.exists());
    }

    #[test]
    fn registration_and_unlaunched_close_do_not_require_a_runtime_argument() {
        let (root, _repository, checkout) = checkout_fixture();
        let mut registration = registration_request(root.path(), &checkout);
        registration["context"]
            .as_object_mut()
            .unwrap()
            .remove("runtimeExecutable");
        let (exit, registered) = invoke("session-v1", &serde_json::to_vec(&registration).unwrap());
        assert_eq!(exit, 0, "{registered}");
        let cancel = serde_json::json!({
            "context": registration["context"],
            "command": {"kind": "close_agent_registration", "binding": registered["value"]["binding"]}
        });
        for _ in 0..2 {
            let (exit, closed) = invoke("session-v1", &serde_json::to_vec(&cancel).unwrap());
            assert_eq!(exit, 0, "{closed}");
            assert!(closed["value"].is_null());
        }
        let checkout_registration = dure_git_checkout::capture_git_checkout_registration(&checkout)
            .unwrap()
            .unwrap();
        assert!(
            dure_git_checkout::read_git_checkout_claims(&checkout_registration)
                .unwrap()
                .is_empty()
        );
        let (exit, _) = invoke("session-v1", &serde_json::to_vec(&registration).unwrap());
        assert_eq!(
            exit, AUTHORITY_ERROR_EXIT,
            "cancelled registration must not reopen"
        );
    }

    #[test]
    fn prior_git_permit_refuses_helper_registration_and_exact_retry_reuses_its_intent() {
        use dure_app::{GitCheckoutRemovalPolicyV1, OperationIdV1};
        use dure_git_checkout::GitCheckoutRemovalOperation;

        let (root, _repository, checkout) = checkout_fixture();
        let registration = registration_request(root.path(), &checkout);
        let encoded = serde_json::to_vec(&registration).unwrap();
        let checkout_registration = dure_git_checkout::capture_git_checkout_registration(&checkout)
            .unwrap()
            .unwrap();
        let operation = GitCheckoutRemovalOperation::new(
            &GitCheckoutRemovalRequestV1 {
                repository_path: checkout_registration.repository_path.clone(),
                instance: checkout_registration.instance.clone(),
                policy: GitCheckoutRemovalPolicyV1::RequireClean,
            },
            &OperationIdV1::new("prior-removal").unwrap(),
        )
        .unwrap();
        let permit = operation.admit().unwrap();
        let (exit, refused) = invoke("session-v1", &encoded);
        assert_eq!(exit, AUTHORITY_ERROR_EXIT, "{refused}");
        assert!(
            refused["error"]["message"]
                .as_str()
                .unwrap()
                .contains("checkout_use_phase_conflict")
        );
        assert!(
            dure_git_checkout::read_git_checkout_claims(&checkout_registration)
                .unwrap()
                .is_empty()
        );
        permit.abort().unwrap();

        let (exit, registered) = invoke("session-v1", &encoded);
        assert_eq!(exit, 0, "{registered}");
        assert_eq!(
            dure_git_checkout::read_git_checkout_claims(&checkout_registration)
                .unwrap()
                .len(),
            1
        );
        let (exit, replay) = invoke("session-v1", &encoded);
        assert_eq!(exit, 0, "{replay}");
        assert_eq!(registered, replay);
        let (exit, closed) = invoke("session-v1", &serde_json::to_vec(&serde_json::json!({
            "context": registration["context"],
            "command": {"kind": "close_agent_registration", "binding": registered["value"]["binding"]}
        })).unwrap());
        assert_eq!(exit, 0, "{closed}");
        assert!(
            dure_git_checkout::read_git_checkout_claims(&checkout_registration)
                .unwrap()
                .is_empty()
        );
    }
}
