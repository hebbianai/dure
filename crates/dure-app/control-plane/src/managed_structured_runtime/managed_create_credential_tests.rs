use super::*;
use crate::managed_create_recovery_test_support::publish_completed_successor_with_capabilities;
use hmux_client::PROVIDER_STATE_ENVIRONMENT_CAPABILITY;
use hmux_host::local_protocol::MANAGED_PROVIDER_CONVERSATION_FENCED_STOP_CAPABILITY;

const CREDENTIAL_HOST_CAPABILITIES: &[&str] = &[
    MANAGED_PROVIDER_CONVERSATION_FENCED_STOP_CAPABILITY,
    PROVIDER_STATE_ENVIRONMENT_CAPABILITY,
];

fn requests(path: &Path) -> Vec<ManagedCreateAdvanceRequest> {
    let bytes = fs::read(path).unwrap();
    let mut bytes = bytes.as_slice();
    let mut requests = Vec::new();
    while !bytes.is_empty() {
        let length = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
        requests.push(serde_json::from_slice(&bytes[4..4 + length]).unwrap());
        bytes = &bytes[4 + length..];
    }
    requests
}

#[tokio::test]
async fn credential_changed_request_stays_prepared_until_create_receipt_is_validated() {
    for failure in [
        "pending",
        "authority_unavailable",
        "rejected",
        "response_loss",
    ] {
        let root = tempfile::Builder::new()
            .prefix("dcr-credential-")
            .tempdir_in("/tmp")
            .unwrap();
        let runtime = root.path().join("fake-hmux-runtime");
        fs::write(
            &runtime,
            format!(
                "#!/bin/sh\ncat >> \"$0.requests\"\nprintf '%s\\n' \"$2\" >> \"$0.calls\"\ncase \"$2\" in\n  {MANAGED_CREATE_ADVANCE_BROKER_SUBCOMMAND}) exec cat \"$0.advance\" ;;\n  *) exit 64 ;;\nesac\n"
            ),
        )
        .unwrap();
        fs::set_permissions(&runtime, fs::Permissions::from_mode(0o700)).unwrap();
        let configuration = ManagedStructuredRuntimeConfiguration {
            backend_generation: "backend-test".into(),
            provider: ManagedProviderExecutable::new(
                ManagedProviderKind::Codex,
                Some(runtime.clone()),
            ),
            provider_launcher_executable: runtime.clone(),
            hmux_runtime: runtime.clone(),
            discovery_root: root.path().join("discovery"),
            address_root: root.path().to_path_buf(),
            state_root: root.path().to_path_buf(),
        };
        let binding = binding();
        let files = runtime_files(&configuration, &binding).unwrap();
        ensure_runtime_directory(&files.directory).unwrap();
        let environment = |profile: &str| {
            ProviderStateEnvironment::new(BTreeMap::from([(
                "CODEX_HOME".into(),
                root.path().join(profile).to_string_lossy().into_owned(),
            )]))
            .unwrap()
        };
        let settings = ProviderTurnSettings::new(ProviderPermissionModeV1::Default, None, None);
        // Only broker frames and catalog manifests are fixtures. The production
        // driver builds the credential-bearing requests and commits checkpoints.
        let (_source_lock, source) = publish_completed_successor_with_capabilities(
            &configuration.discovery_root,
            "workspace-test",
            "codex-chat-prior-successor",
            "codex-create-prior-successor",
            CODEX_PROVIDER_ID,
            CREDENTIAL_HOST_CAPABILITIES,
        );
        write_frame(
            &runtime.with_extension("advance"),
            &ManagedCreateAdvanceBrokerResponse::Advanced(Box::new(source)),
        );
        create_managed_connection_driver(
            &configuration,
            &binding,
            "workspace-test",
            root.path(),
            &files,
            environment("profile-a"),
            &settings,
        )
        .await
        .unwrap();
        let first = requests(&runtime.with_extension("requests")).remove(0);
        let first_digest = digest(&first.request().canonical_create_identity_json().unwrap());
        let checkpoint = || {
            serde_json::from_slice::<serde_json::Value>(
                &fs::read(&files.managed_create_identity).unwrap(),
            )
            .unwrap()
        };
        assert_eq!(checkpoint()["status"]["state"], "effective");
        assert_eq!(checkpoint()["requestDigest"], first_digest);

        let response = match failure {
            "pending" => Some(ManagedCreateAdvanceBrokerResponse::Pending),
            "authority_unavailable" => {
                Some(ManagedCreateAdvanceBrokerResponse::authority_unavailable(
                    "hmux_managed_create_advance_authority_unavailable",
                    "fixture authority unavailable",
                ))
            }
            "rejected" => Some(ManagedCreateAdvanceBrokerResponse::refused(
                "hmux_managed_create_request_digest_conflict",
                "fixture request refused",
            )),
            "response_loss" => None,
            _ => unreachable!(),
        };
        if let Some(response) = response {
            write_frame(&runtime.with_extension("advance"), &response);
        } else {
            fs::write(runtime.with_extension("advance"), []).unwrap();
        }
        for _ in 0..2 {
            let error = create_managed_connection_driver(
                &configuration,
                &binding,
                "workspace-test",
                root.path(),
                &files,
                environment("profile-b"),
                &settings,
            )
            .await
            .unwrap_err();
            let expected = match failure {
                "pending" | "authority_unavailable" => "managed_provider_recovery_pending",
                "rejected" => "managed_provider_managed_create_rejected",
                "response_loss" => "managed_provider_launch_failed",
                _ => unreachable!(),
            };
            assert_eq!(error.code, expected, "{failure}");
            if matches!(failure, "pending" | "authority_unavailable") {
                assert_eq!(error.kind, ErrorKind::RuntimeUnavailable);
            }
            assert!(matches!(
                resolve_managed_create_checkpoint(&files, "workspace-test").unwrap(),
                ManagedCreateCheckpointResolution::Prepared { session_id, idempotency_key }
                    if session_id == "codex-chat-prior-successor"
                        && idempotency_key == "codex-create-prior-successor"
            ));
        }
        let observed = requests(&runtime.with_extension("requests"));
        assert_eq!(observed.len(), 3);
        assert_eq!(
            observed[1].request().session_id(),
            "codex-chat-prior-successor"
        );
        assert_eq!(
            observed[1].request().idempotency_key(),
            "codex-create-prior-successor"
        );
        assert_eq!(
            observed[1], observed[2],
            "retry must replay the complete request"
        );
        let changed_digest = digest(
            &observed[1]
                .request()
                .canonical_create_identity_json()
                .unwrap(),
        );
        assert_ne!(changed_digest, first_digest);
        let prior_identity_request = first
            .request()
            .retarget_identity("codex-create-prior-successor", "codex-chat-prior-successor")
            .unwrap();
        assert_ne!(
            changed_digest,
            digest(
                &prior_identity_request
                    .canonical_create_identity_json()
                    .unwrap()
            ),
            "credential environment must change the digest even at the same identity"
        );
        assert_eq!(
            observed[1].request(),
            &prior_identity_request
                .with_provider_state_environment(environment("profile-b"))
                .unwrap(),
            "the changed request differs only in credential environment"
        );
        assert_eq!(
            observed[1].request().provider_state_environment(),
            &environment("profile-b")
        );
        assert_eq!(checkpoint()["requestDigest"], changed_digest);
        assert_eq!(checkpoint()["status"]["state"], "prepared");

        let before = fs::read(&files.managed_create_identity).unwrap();
        assert!(
            create_managed_connection_driver(
                &configuration,
                &binding,
                "workspace-test",
                root.path(),
                &files,
                environment("profile-c"),
                &settings,
            )
            .await
            .is_err()
        );
        assert_eq!(fs::read(&files.managed_create_identity).unwrap(), before);
        assert_eq!(requests(&runtime.with_extension("requests")).len(), 3);

        let (_target_lock, target) = publish_completed_successor_with_capabilities(
            &configuration.discovery_root,
            "workspace-test",
            "codex-chat-successor",
            "codex-create-successor",
            CODEX_PROVIDER_ID,
            CREDENTIAL_HOST_CAPABILITIES,
        );
        write_frame(
            &runtime.with_extension("advance"),
            &ManagedCreateAdvanceBrokerResponse::Advanced(Box::new(target)),
        );
        create_managed_connection_driver(
            &configuration,
            &binding,
            "workspace-test",
            root.path(),
            &files,
            environment("profile-b"),
            &settings,
        )
        .await
        .unwrap();
        assert!(matches!(
            resolve_managed_create_checkpoint(&files, "workspace-test").unwrap(),
            ManagedCreateCheckpointResolution::Effective { session_id, idempotency_key }
                if session_id == "codex-chat-successor" && idempotency_key == "codex-create-successor"
        ));
        assert_eq!(checkpoint()["requestDigest"], changed_digest);
        assert_eq!(
            fs::read_to_string(runtime.with_extension("calls")).unwrap(),
            format!("{MANAGED_CREATE_ADVANCE_BROKER_SUBCOMMAND}\n").repeat(4),
        );
    }
}
