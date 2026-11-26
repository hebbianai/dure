use super::conformance_support::*;
use super::*;
use dure_app::*;
use serde_json::json;
use tokio::time::{Duration, timeout};

#[test]
#[ignore = "requires isolated actual Pi, deterministic model backend and Hmux fixture"]
fn live_pi_preserves_conversation_across_settings_busy_turns_and_reconnect() {
    let root = env_path("DURE_QA_PI_RUNTIME_ROOT");
    let run = |reconnect| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(exercise(&root, reconnect))
    };
    let (first, descriptor, endpoint) = run(false);
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            release(3).await;
            let (observer, _events) = crate::pi_session_client::PiSessionClient::connect(
                &endpoint,
                &root.join("workspace-0"),
                &first,
            )
            .await
            .unwrap();
            timeout(Duration::from_secs(20), async {
                loop {
                    let state = observer.state().await.unwrap();
                    if !state.busy() {
                        let entries = observer
                            .history(
                                &state,
                                crate::pi_session_client::HistoryWindowBounds::ATTACH,
                            )
                            .await
                            .unwrap();
                        assert!(entries.entries.iter().any(|entry| {
                            entry
                                .pointer("/message/content/0/text")
                                .and_then(serde_json::Value::as_str)
                                == Some("DURE_PI_BLOCK_3")
                        }));
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(30)).await;
                }
            })
            .await
            .expect("Pi must complete its accepted turn while the CP is disconnected");
            let decoy = tokio::process::Command::new(env_path("DURE_QA_PI_BIN"))
                .args([
                    "--print",
                    "--session-id",
                    "780ae739-a1f9-4f86-8173-93e51c358c62",
                    "--model",
                    "fixture/model-a",
                    "--thinking",
                    "low",
                    "DURE_PI_DECOY",
                ])
                .current_dir(root.join("workspace-0"))
                .output()
                .await
                .unwrap();
            assert!(
                decoy.status.success(),
                "newer decoy session must be created"
            );
        });
    let (reconnected, observed, _) = run(true);
    assert_eq!(first, reconnected);
    assert_eq!(descriptor.host_instance_id, observed.host_instance_id);
    assert_eq!(descriptor.session_id, observed.session_id);
}

/// A Terminal Agent's Pi conversation moved into Chat, longer than one Pi
/// answer and than the window Chat seeds: 200 turns, each a prompt of about
/// 400 KB and its answer. Pi records the first turn itself; the others repeat
/// its records the way Pi appends them, before the managed runtime resumes
/// the conversation.
#[test]
#[ignore = "requires isolated actual Pi, deterministic model backend and Hmux fixture"]
fn live_pi_opens_a_long_terminal_conversation_in_chat() {
    let root = env_path("DURE_QA_PI_RUNTIME_ROOT").join("long");
    tests::owner_directory(&root);
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let (store, service, manager) = fixture(
                &root,
                false,
                ManagedProviderKind::Pi,
                env_path("DURE_QA_PI_BIN"),
            )
            .await;
            let session = "4c1f2f0e-6b7a-4f43-9d2e-0a5b8c6d7e81";
            let bytes = record_terminal_conversation(&root.join("workspace-0"), session, 200).await;
            assert!(bytes > 64 * 1024 * 1024, "the Terminal history is {bytes} bytes");
            let agent = AgentIdV1::new("agent-pi-scale-0").unwrap();
            let chat = settings("fixture/model-a", "low");
            select_chat(&store, &agent, &chat).await;

            let opening = std::time::Instant::now();
            let binding = manager
                .open_runtime(open_request(&agent, Some(session.into()), &chat))
                .await
                .expect("a long Terminal conversation opens in Chat");
            let opened = opening.elapsed();

            let shown = conversation(&service, &binding).await;
            assert_eq!(shown[0], "boundary:provider_history_truncated");
            let first = shown[1]
                .strip_prefix("Terminal prompt ")
                .and_then(|index| index.parse::<usize>().ok())
                .unwrap();
            let newest = (first..200)
                .map(|index| format!("Terminal prompt {index}"))
                .collect::<Vec<_>>();
            assert_eq!(
                shown[1..],
                newest,
                "the newest prompts, each once, in order"
            );
            // The window holds the newest 64 MiB of the about 80 MB history.
            assert!((1..=60).contains(&first), "window starts at prompt {first}");
            assert!(
                !binding.history_complete,
                "the window leaves the older history out"
            );
            println!(
                "Chat opened in {opened:?} with Terminal prompts {first} to 199 behind a history boundary"
            );

            let intent = turn_intent(
                &binding,
                "after-terminal",
                "Continue after the Terminal history.",
            );
            service
                .start_turn(bridge(&manager, &binding).await.as_ref(), &intent)
                .await
                .unwrap();
            wait_completed(&service, &binding, &intent.turn_id).await;
            let shown = conversation(&service, &binding).await;
            assert_eq!(
                shown.last().map(String::as_str),
                Some("Continue after the Terminal history."),
                "a Chat prompt follows the history"
            );
            assert_eq!(
                shown
                    .iter()
                    .filter(|row| row.starts_with("boundary:"))
                    .count(),
                1
            );
            manager.stop_binding(&binding, false).await.unwrap();
        });
}

/// A Terminal Agent's Pi conversation in which the person ran `!` and `!!`
/// shell commands, moved into Chat. Pi records each as a `bashExecution`
/// message with no content. Chat shows them as the command lines the person
/// ran, and its next prompt reaches a model that has the `!` command's output
/// in its context and not the `!!` one's
/// (`scripts/qa/pi-provider-conformance.mjs` checks the model's side). That
/// prompt is an automatic turn, as a goal sends, which the store admits only
/// for a history it settled as complete.
#[test]
#[ignore = "requires isolated actual Pi, deterministic model backend and Hmux fixture"]
fn live_pi_opens_a_terminal_conversation_with_shell_commands_in_chat() {
    let root = env_path("DURE_QA_PI_RUNTIME_ROOT").join("shell");
    tests::owner_directory(&root);
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let (store, service, manager) = fixture(
                &root,
                false,
                ManagedProviderKind::Pi,
                env_path("DURE_QA_PI_BIN"),
            )
            .await;
            let session = "9d3b6a52-2f1e-4c8b-8a47-5e0f1c2d3b64";
            let workspace = root.join("workspace-0");
            record_terminal_conversation(&workspace, session, 1).await;
            run_shell_commands(
                &workspace,
                session,
                &[
                    ("printf DURE_PI_SHELL_OUTPUT", false),
                    ("printf DURE_PI_PRIVATE_OUTPUT", true),
                ],
            )
            .await;
            let agent = AgentIdV1::new("agent-pi-scale-0").unwrap();
            let chat = settings("fixture/model-a", "low");
            select_chat(&store, &agent, &chat).await;

            let binding = manager
                .open_runtime(open_request(&agent, Some(session.into()), &chat))
                .await
                .expect("a Terminal conversation with shell commands opens in Chat");
            assert_eq!(
                conversation(&service, &binding).await,
                [
                    "Terminal prompt 0",
                    "! printf DURE_PI_SHELL_OUTPUT",
                    "!! printf DURE_PI_PRIVATE_OUTPUT",
                ]
            );

            // The moved conversation is whole, so the store admits the
            // automatic turn a goal continues it with.
            assert!(binding.history_complete);
            let intent = turn_intent(
                &binding,
                "after-shell",
                "DURE_PI_SHELL_CONTEXT continue after the shell commands.",
            );
            let continued = service
                .continue_turn(
                    bridge(&manager, &binding).await.as_ref(),
                    &AgentContinueTurnRequestV1 {
                        intent: intent.clone(),
                        expected_cursor: page(&service, &binding).await.final_cursor,
                    },
                )
                .await
                .unwrap();
            assert!(continued.is_some(), "the automatic turn is admitted");
            wait_completed(&service, &binding, &intent.turn_id).await;
            assert_eq!(
                conversation(&service, &binding)
                    .await
                    .last()
                    .map(String::as_str),
                Some("DURE_PI_SHELL_CONTEXT continue after the shell commands."),
                "a Chat prompt follows the shell commands"
            );
            manager.stop_binding(&binding, false).await.unwrap();
        });
}

/// Selects Chat for the fixture's Agent with `chat`'s settings.
async fn select_chat(store: &SqliteDomainStore, agent: &AgentIdV1, chat: &ProviderTurnSettings) {
    store
        .initialize_agent_runtime_selection(&AgentRuntimeSelectionV1 {
            schema_version: 1,
            agent_id: agent.clone(),
            provider_id: ProviderIdV1::new("pi").unwrap(),
            interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
            execution_profile: AgentExecutionProfileV1::ProviderDefault,
            permission_mode: chat.permission_mode.clone(),
            model: chat.model.clone(),
            effort: chat.effort.clone(),
            revision: 1,
            selected_by_operation_id: None,
            updated_at_ms: 4,
        })
        .await
        .unwrap();
}

/// Runs each command in `session` as the person's `!` input, or `!!` input
/// when it is `excluded` from the model's context, the way Pi's Terminal runs
/// it: through Pi's RPC `bash` command, which Pi records with the same call.
async fn run_shell_commands(workspace: &Path, session: &str, commands: &[(&str, bool)]) {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let mut pi = tokio::process::Command::new(env_path("DURE_QA_PI_BIN"))
        .args(["--mode", "rpc", "--session", session])
        .current_dir(workspace)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut stdin = pi.stdin.take().unwrap();
    let mut stdout = BufReader::new(pi.stdout.take().unwrap()).lines();
    for (index, (command, excluded)) in commands.iter().enumerate() {
        let request = json!({
            "id": format!("shell-{index}"),
            "type": "bash",
            "command": command,
            "excludeFromContext": excluded,
        });
        stdin
            .write_all(format!("{request}\n").as_bytes())
            .await
            .unwrap();
        let response = timeout(Duration::from_secs(20), async {
            loop {
                let line = stdout.next_line().await.unwrap().expect("Pi answers");
                let Ok(record) = serde_json::from_str::<serde_json::Value>(&line) else {
                    continue;
                };
                if record["type"] == "response" && record["id"] == request["id"] {
                    break record;
                }
            }
        })
        .await
        .expect("Pi runs the shell command");
        assert_eq!(response["success"], json!(true), "{response}");
    }
    drop(stdin);
    let status = timeout(Duration::from_secs(20), pi.wait())
        .await
        .expect("Pi exits when its input closes")
        .unwrap();
    assert!(status.success());
}

/// Records `count` turns of `session` in `workspace` and returns the size of
/// its transcript. Pi answers the first prompt through the fixture model, as
/// a person's Terminal session would; the later turns repeat those records
/// under new entry IDs, so the fixture model is not sent the whole growing
/// conversation for each of them.
async fn record_terminal_conversation(workspace: &Path, session: &str, count: usize) -> u64 {
    use std::io::Write;
    let recorded = tokio::process::Command::new(env_path("DURE_QA_PI_BIN"))
        .args([
            "--print",
            "--session-id",
            session,
            "--model",
            "fixture/model-a",
            "--thinking",
            "low",
            "Terminal prompt 0",
        ])
        .current_dir(workspace)
        .output()
        .await
        .unwrap();
    assert!(recorded.status.success(), "Pi records the first turn");
    let transcript = find_transcript(&env_path("PI_CODING_AGENT_DIR"), session)
        .expect("Pi wrote the Terminal transcript");
    let entries = std::fs::read_to_string(&transcript)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .collect::<Vec<_>>();
    let role = |entry: &serde_json::Value| entry.pointer("/message/role").cloned();
    let prompt = entries
        .iter()
        .find(|entry| role(entry) == Some(json!("user")))
        .unwrap();
    let answer = entries.last().unwrap();
    assert_eq!(role(answer), Some(json!("assistant")));
    let mut parent = answer["id"].clone();
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&transcript)
        .unwrap();
    for index in 1..count {
        let (prompt_id, answer_id) = (format!("p{index:07}"), format!("a{index:07}"));
        let mut next = prompt.clone();
        next["id"] = json!(prompt_id);
        next["parentId"] = parent;
        next["message"]["content"] = json!([{
            "type": "text",
            "text": format!("Terminal prompt {index} {}", "T".repeat(400_000)),
        }]);
        next["message"]["timestamp"] =
            json!(prompt["message"]["timestamp"].as_i64().unwrap() + index as i64);
        let mut reply = answer.clone();
        reply["id"] = json!(answer_id);
        reply["parentId"] = json!(prompt_id);
        reply["message"]["timestamp"] = next["message"]["timestamp"].clone();
        reply["message"]["content"] =
            json!([{"type":"text","text":format!("Terminal answer {index}")}]);
        writeln!(file, "{next}\n{reply}").unwrap();
        parent = json!(answer_id);
    }
    file.sync_all().unwrap();
    file.metadata().unwrap().len()
}

fn find_transcript(directory: &Path, session: &str) -> Option<PathBuf> {
    std::fs::read_dir(directory).ok()?.find_map(|entry| {
        let path = entry.ok()?.path();
        if path.is_dir() {
            find_transcript(&path, session)
        } else {
            path.file_name()?
                .to_str()?
                .ends_with(&format!("_{session}.jsonl"))
                .then_some(path)
        }
    })
}

/// The file the fixture model asks Pi to write: more than one timeline item
/// holds. `scripts/qa/pi-provider-conformance.mjs` writes the same size.
const LARGE_WRITE_BYTES: u64 = 200_000;

fn settings(model: &str, effort: &str) -> ProviderTurnSettings {
    ProviderTurnSettings::new(
        ProviderPermissionModeV1::Default,
        Some(AgentSpawnModelSelectionV1::parse(model).unwrap()),
        Some(AgentSpawnEffortSelectionV1::parse(effort).unwrap()),
    )
}

async fn release(index: usize) {
    reqwest::get(format!(
        "{}/release/{index}",
        std::env::var("DURE_QA_PI_FIXTURE_URL").unwrap()
    ))
    .await
    .unwrap()
    .error_for_status()
    .unwrap();
}

async fn replace(
    manager: &Manager,
    service: &AgentConversationService<SqliteDomainStore>,
    store: &SqliteDomainStore,
    binding: &AgentInteractionBindingV1,
    next: &ProviderTurnSettings,
    transition: &AgentRuntimeTransitionRecordV1,
) -> AgentInteractionBindingV1 {
    manager.stop_replacement(transition).await.unwrap();
    let stopped = advance(
        store,
        transition,
        AgentRuntimeTransitionAdvanceV1::SourceStopped,
    )
    .await;
    let target = manager
        .open_replacement_runtime(
            open_request(
                &binding.agent_id,
                binding.provider_conversation_ref.clone(),
                next,
            ),
            &stopped,
            ProviderStateEnvironment::default(),
        )
        .await
        .unwrap();
    let started = advance(
        store,
        &stopped,
        AgentRuntimeTransitionAdvanceV1::TargetStarted {
            workspace: None,
            authority: Box::new(AgentRuntimeBindingAuthorityV1::StructuredProtocol {
                binding: target.clone(),
            }),
            launch_idempotency_key: None,
        },
    )
    .await;
    advance(store, &started, AgentRuntimeTransitionAdvanceV1::Committed).await;
    assert_eq!(
        target.provider_conversation_ref,
        binding.provider_conversation_ref
    );
    assert_eq!(
        service
            .binding(&binding.interaction_session_id)
            .await
            .unwrap(),
        Some(target.clone())
    );
    target
}

async fn exercise(
    root: &Path,
    reconnect: bool,
) -> (AgentInteractionBindingV1, SessionDescriptor, PathBuf) {
    let (store, service, manager) = fixture(
        root,
        reconnect,
        ManagedProviderKind::Pi,
        env_path("DURE_QA_PI_BIN"),
    )
    .await;
    let agent = AgentIdV1::new("agent-pi-scale-0").unwrap();
    let initial = settings("fixture/model-a", "low");
    let mut binding = if reconnect {
        let selection = store
            .agent_runtime_selection(&agent)
            .await
            .unwrap()
            .unwrap();
        let binding = service.binding_for_agent(&agent).await.unwrap().unwrap();
        manager
            .attach_existing_runtime(&selection, &binding)
            .await
            .unwrap()
    } else {
        store
            .initialize_agent_runtime_selection(&AgentRuntimeSelectionV1 {
                schema_version: 1,
                agent_id: agent.clone(),
                provider_id: ProviderIdV1::new("pi").unwrap(),
                interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
                execution_profile: AgentExecutionProfileV1::ProviderDefault,
                permission_mode: initial.permission_mode.clone(),
                model: initial.model.clone(),
                effort: initial.effort.clone(),
                revision: 1,
                selected_by_operation_id: None,
                updated_at_ms: 4,
            })
            .await
            .unwrap();
        manager
            .open_runtime(open_request(&agent, None, &initial))
            .await
            .unwrap()
    };
    if !reconnect {
        assert!(
            binding.provider_conversation_ref.is_none(),
            "Pi has not persisted an empty conversation yet"
        );
        let expected = crate::pi_session_client::SessionId::for_binding(&binding).unwrap();
        let next = settings("fixture/model-a", "high");
        let empty = admit(&store, &binding, &next, 0).await;
        binding = replace(&manager, &service, &store, &binding, &next, &empty).await;
        assert_eq!(
            crate::pi_session_client::SessionId::for_binding(&binding).unwrap(),
            expected
        );
        let warmup = turn_intent(
            &binding,
            "pi-warmup",
            "한글 입력\nDURE_PI_ALLOCATE keep the exact Pi conversation",
        );
        service
            .start_turn(bridge(&manager, &binding).await.as_ref(), &warmup)
            .await
            .unwrap();
        let allocating = admit(&store, &binding, &settings("fixture/model-b", "high"), 99).await;
        let slot = manager
            .slots
            .lock()
            .await
            .get(&binding.interaction_session_id)
            .unwrap()
            .clone();
        let original = slot.lock().await.as_ref().unwrap().bridge.clone();
        slot.lock().await.as_mut().unwrap().bridge = Arc::new(AllocationDuringDrain {
            inner: original.clone(),
            service: service.clone(),
            binding: binding.clone(),
            turn: warmup.turn_id.clone(),
        });
        let failure = manager
            .stop_replacement(&allocating)
            .await
            .expect_err("identity publication while draining must retain the running source");
        assert_eq!(failure.kind, ErrorKind::RuntimeConflict);
        assert!(
            original.is_connected(),
            "the retained Pi process must remain usable"
        );
        slot.lock().await.as_mut().unwrap().bridge = original;
        advance(
            &store,
            &allocating,
            AgentRuntimeTransitionAdvanceV1::SourceRetained,
        )
        .await;
        binding = service.binding_for_agent(&agent).await.unwrap().unwrap();
        assert_eq!(
            binding.provider_conversation_ref.as_deref(),
            Some(expected.as_str())
        );
        for (index, next) in [
            (1, settings("fixture/model-b", "high")),
            (2, settings("fixture/model-b", "low")),
        ] {
            let commands = bridge(&manager, &binding).await;
            let turn = turn_intent(
                &binding,
                &format!("pi-block-{index}"),
                &format!("DURE_PI_BLOCK_{index}"),
            );
            service.start_turn(commands.as_ref(), &turn).await.unwrap();
            let transition = admit(&store, &binding, &next, index).await;
            let error = manager.stop_replacement(&transition).await.unwrap_err();
            assert_eq!(error.kind, ErrorKind::SourceBusy);
            assert_eq!(
                service.binding_for_agent(&agent).await.unwrap(),
                Some(binding.clone())
            );
            let stale = commands
                .interrupt_turn(
                    &binding,
                    &AgentInterruptTurnRequestV1 {
                        schema_version: 1,
                        interaction_session_id: binding.interaction_session_id.clone(),
                        runtime: binding.runtime.clone(),
                        turn_id: AgentTurnIdV1::new("stale-turn").unwrap(),
                        client_message_id: turn.client_message_id.clone(),
                        interrupt_request_id: format!("stale-interrupt-{index}"),
                        requested_at_ms: now_ms().unwrap(),
                    },
                )
                .await
                .unwrap_err();
            assert_eq!(stale.code, "stale_turn");
            release(index).await;
            wait_completed(&service, &binding, &turn.turn_id).await;
            // A repeated canonical input must never ask the model twice.
            service.start_turn(commands.as_ref(), &turn).await.unwrap();
            binding = replace(&manager, &service, &store, &binding, &next, &transition).await;
        }
        let commands = bridge(&manager, &binding).await;
        let question = turn_intent(&binding, "pi-question", "DURE_PI_QUESTION");
        service
            .start_turn(commands.as_ref(), &question)
            .await
            .unwrap();
        let pending = timeout(Duration::from_secs(10), async {
            loop {
                if let Some(request) = page(&service, &binding).await.pending_requests.first() {
                    break request.clone();
                }
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
        })
        .await
        .expect("Pi extension question must reach the common pending surface");
        service
            .answer_pending(
                commands.as_ref(),
                &AgentPendingAnswerIntentV1 {
                    schema_version: 1,
                    interaction_session_id: binding.interaction_session_id.clone(),
                    runtime: binding.runtime.clone(),
                    request_id: pending.request.request_id,
                    client_message_id: pending.request.client_message_id,
                    idempotency_key: "pi-question-answer".into(),
                    answer: json!({"answers":{"answer":"Fixture approved answer"}}),
                    requested_at_ms: now_ms().unwrap(),
                },
            )
            .await
            .unwrap();
        wait_completed(&service, &binding, &question.turn_id).await;
        assert!(page(&service, &binding).await.pending_requests.is_empty());
        // Pi writes a file larger than one timeline item. Its tool call
        // fits without its input, so the turn completes on the same live
        // connection, and the reconnect below seeds it again from Pi.
        let large = turn_intent(&binding, "pi-large-write", "DURE_PI_LARGE_WRITE");
        service.start_turn(commands.as_ref(), &large).await.unwrap();
        wait_completed(&service, &binding, &large.turn_id).await;
        assert!(commands.is_connected());
        assert_eq!(
            std::fs::metadata(root.join("workspace-0/large-write.txt"))
                .unwrap()
                .len(),
            LARGE_WRITE_BYTES
        );
        assert!(page(&service, &binding).await.rows.iter().any(|row| {
            row.item.turn_id.as_ref() == Some(&large.turn_id)
                && matches!(
                    &row.item.body,
                    AgentTimelineItemBodyV1::Tool { name, input: None, .. } if name == "write"
                )
        }));
        let offline = turn_intent(&binding, "pi-offline", "DURE_PI_BLOCK_3");
        service
            .start_turn(bridge(&manager, &binding).await.as_ref(), &offline)
            .await
            .unwrap();
    } else {
        let turn = turn_intent(
            &binding,
            "pi-reconnected",
            "Continue the same Pi conversation after reconnect.",
        );
        service
            .start_turn(bridge(&manager, &binding).await.as_ref(), &turn)
            .await
            .unwrap();
        wait_completed(&service, &binding, &turn.turn_id).await;
        let observed = page(&service, &binding).await;
        assert_eq!(
            observed
                .rows
                .iter()
                .filter(|row| matches!(
                    &row.item.body,
                    AgentTimelineItemBodyV1::Message {
                        role: AgentTimelineMessageRoleV1::User,
                        ..
                    }
                ))
                .count(),
            7
        );
        assert!(!observed.rows.iter().any(|row| matches!(&row.item.body, AgentTimelineItemBodyV1::Message { markdown, .. } if markdown.contains("DURE_PI_DECOY"))));
    }
    let slot = manager
        .slots
        .lock()
        .await
        .get(&binding.interaction_session_id)
        .unwrap()
        .clone();
    let descriptor = slot.lock().await.as_ref().unwrap().descriptor.clone();
    let endpoint = slot.lock().await.as_ref().unwrap().files.endpoint.clone();
    if reconnect {
        manager.stop_binding(&binding, false).await.unwrap();
    }
    (binding, descriptor, endpoint)
}

/// Force the real provider's first persisted answer into the interval between
/// transition admission and drain completion, without scheduling assumptions.
struct AllocationDuringDrain {
    inner: Arc<dyn ManagedProviderConnection>,
    service: Arc<AgentConversationService<SqliteDomainStore>>,
    binding: AgentInteractionBindingV1,
    turn: AgentTurnIdV1,
}
impl crate::agent_conversation::AgentProviderCommands for AllocationDuringDrain {
    fn start_turn<'a>(
        &'a self,
        binding: &'a AgentInteractionBindingV1,
        intent: &'a AgentStartTurnIntentV1,
    ) -> crate::agent_conversation::AgentProviderCommandFuture<'a> {
        self.inner.start_turn(binding, intent)
    }
    fn answer_pending<'a>(
        &'a self,
        binding: &'a AgentInteractionBindingV1,
        intent: &'a AgentPendingAnswerIntentV1,
        request: &'a AgentPendingRequestV1,
    ) -> crate::agent_conversation::AgentProviderCommandFuture<'a> {
        self.inner.answer_pending(binding, intent, request)
    }
    fn interrupt_turn<'a>(
        &'a self,
        binding: &'a AgentInteractionBindingV1,
        request: &'a AgentInterruptTurnRequestV1,
    ) -> crate::agent_conversation::AgentProviderCommandFuture<'a> {
        self.inner.interrupt_turn(binding, request)
    }
}
impl ManagedProviderConnection for AllocationDuringDrain {
    fn is_connected(&self) -> bool {
        self.inner.is_connected()
    }
    fn cancel_drain(&self) {
        self.inner.cancel_drain();
    }
    fn begin_idle_drain(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + '_>> {
        Box::pin(async move {
            release(0).await;
            wait_completed(&self.service, &self.binding, &self.turn).await;
            self.inner.begin_idle_drain().await
        })
    }
}
