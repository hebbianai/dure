use super::*;
use hmux_client::{AgentRuntimeActivity, AgentRuntimeAttention};

#[tokio::test]
#[ignore = "requires isolated real Hmux; use scripts/qa/hmux-control-plane-smoke.mjs"]
async fn named_cli_resume_wakes_a_deferred_source_without_an_app() {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    let starts = root.path().join("provider-starts");
    fs::write(
        root.path().join("codex-fixture"),
        format!(
            "#!/bin/sh\nprintf 'started\\n' >> '{}'\nexec sleep 120\n",
            starts.display()
        ),
    )
    .unwrap();
    let hmux = RealHmux::install(root, &mut state);
    make_fixture_mutation_authority(&mut state);
    let agent_id = AgentIdV1::new("cli-deferred-resume-agent").unwrap();
    let source = launch(&state, &hmux, "cli-deferred-source").await;
    bind_source(&state, &agent_id, &source).await;
    wait_for_provider_starts(&starts, 1).await;
    state_reporter::report(
        &hmux,
        &source,
        AgentRuntimeActivity::Waiting,
        AgentRuntimeAttention::None,
        true,
    );
    let state = publication_state(state);
    let _server = PublicationServer::start(Arc::clone(&state));
    let registry = json!({"agents": [{"id": agent_id, "name": "worker", "project": "fixture",
        "sessionId": "stale-client-session", "workspaceId": "stale-client-workspace"}]});
    for attempt in 0..2 {
        let revision = inspect(&state, &agent_id).await["receipt"]["selectionRevision"].to_string();
        let (ok, hibernated) = run_cli(
            &state,
            &hmux.root,
            &[
                "runtime",
                "hibernate",
                agent_id.as_str(),
                "--expected-revision",
                &revision,
                "--backend",
                "fixture",
                "--json",
            ],
            None,
            None,
        )
        .await;
        assert!(ok, "{hibernated}");
        assert_eq!(hibernated["result"]["stage"], "source_stopped");
        assert_eq!(hibernated["result"]["deferredTarget"]["state"], "waiting");
        let mut args = vec![
            "hmux",
            "rehost",
            "--name",
            "fixture/worker",
            "--backend",
            "fixture",
            "--json",
        ];
        if attempt == 1 {
            args.push("--confirm-restart");
        }
        let (ok, report) = run_cli(&state, &hmux.root, &args, Some(registry.clone()), None).await;
        assert!(ok, "{report}");
        let continuation = &report["continuation"];
        assert_eq!(continuation["kind"], "runtime_wake");
        assert_eq!(
            continuation["operationId"],
            hibernated["result"]["operationId"]
        );
        assert_eq!(
            continuation["expectedJournalRevision"],
            hibernated["result"]["journalRevision"]
        );
        assert!(continuation.get("publish").is_none());
        if attempt == 0 {
            assert_eq!(report["state"], "preview");
            assert_eq!(hmux.requests().len(), 1, "preview cannot wake the source");
        } else {
            assert_eq!(report["backendExecution"], "completed");
            assert_eq!(report["publication"], "published");
        }
        // The same retained command works from a new CLI process, including
        // after a successful response was lost. There is no app or Hmux CLI.
        let retry: Vec<&str> = continuation["retry"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap())
            .collect();
        for _ in 0..2 {
            let (ok, replay) = run_cli(&state, &hmux.root, &retry, None, None).await;
            assert!(ok, "{replay}");
            assert_eq!(replay["result"]["state"], "stable");
            assert_eq!(
                replay["result"]["receipt"]["providerConversationRef"],
                CONVERSATION
            );
        }
        wait_for_provider_starts(&starts, attempt + 2).await;
        assert_eq!(
            hmux.requests().len(),
            attempt + 2,
            "one wake starts exactly one provider"
        );
        let current = inspect(&state, &agent_id).await;
        assert_eq!(current["state"], "stable");
        assert_eq!(current["receipt"]["providerConversationRef"], CONVERSATION);
        let session = hmux.requests().last().unwrap().session_id.clone();
        let descriptor = hmux_client::LocalSessionCatalog::new(&hmux.discovery)
            .find(&hmux_client::SessionSelector::new(&session, None))
            .unwrap();
        assert_eq!(descriptor.lifecycle, hmux_client::SessionLifecycle::Ready);
        let generation = WorkflowSessionGenerationV1 {
            session_id: descriptor.session_id,
            workspace_id: descriptor.workspace_id,
            provider_id: ProviderIdV1::new("codex").unwrap(),
            runner_principal: descriptor.runner_principal,
            runner_instance: descriptor.runner_instance,
            channel_epoch: descriptor.channel_epoch,
            host_instance_id: descriptor.host_instance_id,
            terminal_epoch: descriptor.terminal_epoch,
        };
        state_reporter::report(
            &hmux,
            &generation,
            AgentRuntimeActivity::Waiting,
            AgentRuntimeAttention::None,
            true,
        );
        if attempt == 1 {
            hmux.stop(&generation);
        }
    }
}
