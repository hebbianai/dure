use std::collections::BTreeMap;

use dure_app::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::agent_conversation::AgentProviderCommandErrorV1 as Error;
use crate::pi_session_client::{Entries, field};
use crate::provider_timeline_journal::{digest, protocol_error, store_error};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct TurnContext {
    pub(super) turn_id: AgentTurnIdV1,
    pub(super) client_message_id: AgentClientMessageIdV1,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PromptAnchor {
    pub(super) context: TurnContext,
    pub(super) previous_leaf: Option<String>,
    pub(super) runtime: AgentProviderRuntimeFenceV1,
}

pub(super) fn item(
    key: &str,
    context: Option<&TurnContext>,
    provider: Option<&str>,
    body: AgentTimelineItemBodyV1,
    at: i64,
) -> Result<AgentTimelineItemDraftV1, Error> {
    let item = AgentTimelineItemDraftV1 {
        item_id: AgentTimelineItemIdV1::new(format!("pi-{}", digest(key))).map_err(store_error)?,
        turn_id: context.map(|turn| turn.turn_id.clone()),
        client_message_id: context.map(|turn| turn.client_message_id.clone()),
        provider_message_id: provider
            .map(|id| AgentProviderMessageIdV1::new(format!("pi-{id}")).map_err(store_error))
            .transpose()?,
        // One oversized part must not fail its whole message.
        body: body.fitted(),
        created_at_ms: at,
    };
    item.validate().map_err(store_error)?;
    Ok(item)
}

pub(super) fn lifecycle(
    context: &TurnContext,
    state: AgentTimelineLifecycleStateV1,
    at: i64,
) -> Result<AgentTimelineItemDraftV1, Error> {
    item(
        &format!("turn:{}:{state:?}", context.turn_id),
        Some(context),
        None,
        AgentTimelineItemBodyV1::Lifecycle {
            state,
            detail: None,
        },
        at,
    )
}

/// The selected conversation branch, oldest first.
pub(super) struct Branch<'a> {
    pub(super) entries: Vec<&'a Value>,
    /// The entry before the branch's oldest one, which a window leaves out.
    /// `None` when the branch starts the conversation.
    pub(super) before: Option<&'a str>,
}

/// Follow parent IDs from the explicit leaf. Append order also contains forks;
/// it is not the selected conversation branch and must never seed a transcript.
/// In a window that leaves older entries out, the branch starts at its oldest
/// entry the window holds.
pub(super) fn branch(entries: &Entries) -> Result<Branch<'_>, Error> {
    let mut by_id = BTreeMap::new();
    for entry in &entries.entries {
        let id = field(entry, "id")?;
        if by_id.insert(id, entry).is_some() {
            return Err(protocol_error("Pi entry IDs repeat"));
        }
    }
    let mut cursor = entries.leaf_id.as_deref();
    let mut selected = Vec::new();
    while let Some(id) = cursor {
        let Some(entry) = by_id.get(id).copied() else {
            if !entries.omits_older {
                return Err(protocol_error("Pi branch has a missing parent"));
            }
            break;
        };
        selected.push(entry);
        if selected.len() > entries.entries.len() {
            return Err(protocol_error("Pi branch contains a cycle"));
        }
        cursor = match entry.get("parentId") {
            Some(Value::Null) => None,
            Some(Value::String(id)) => Some(id),
            _ => return Err(protocol_error("Pi entry parent is missing")),
        };
    }
    selected.reverse();
    Ok(Branch {
        entries: selected,
        before: cursor,
    })
}

/// Keeps what the next projection needs for the turn in progress: the
/// branch's newest prompt and the entries between it and the message before
/// it. A prompt Dure sent is anchored at the leaf it was sent at, and Pi may
/// append other entries, such as a model change, before the prompt itself.
/// The timeline holds what the entries before them projected, and what Pi
/// appends next follows them.
pub(super) fn retain_newest_turn(entries: &mut Entries) -> Result<(), Error> {
    let message = |entry: &&Value| entry.get("type").and_then(Value::as_str) == Some("message");
    let selected = branch(entries)?.entries;
    let Some(prompt) = selected.iter().rposition(|entry| {
        message(entry) && entry.pointer("/message/role").and_then(Value::as_str) == Some("user")
    }) else {
        return Ok(());
    };
    let Some(before) = selected[..prompt].iter().rposition(message) else {
        return Ok(());
    };
    let first = field(selected[before + 1], "id")?.to_owned();
    let start = entries
        .entries
        .iter()
        .position(|entry| entry.get("id").and_then(Value::as_str) == Some(&first))
        .ok_or_else(|| protocol_error("Pi branch entry missing"))?;
    entries.entries.drain(..start);
    entries.omits_older = true;
    Ok(())
}

pub(super) struct ProjectedHistory {
    pub(super) items: Vec<AgentTimelineItemDraftV1>,
    pub(super) accepted: BTreeMap<AgentClientMessageIdV1, String>,
    pub(super) completed: std::collections::BTreeSet<AgentClientMessageIdV1>,
    /// Whether the conversation continues before the oldest entry the items
    /// show, which a window left out.
    pub(super) omits_older: bool,
}

pub(super) fn project(
    entries: &Entries,
    anchors: &BTreeMap<AgentClientMessageIdV1, PromptAnchor>,
) -> Result<ProjectedHistory, Error> {
    let mut at_leaf = BTreeMap::new();
    for anchor in anchors.values() {
        if at_leaf
            .insert(anchor.previous_leaf.as_deref(), &anchor.context)
            .is_some()
        {
            return Err(protocol_error("Pi prompt boundaries conflict"));
        }
    }
    let Branch {
        entries: selected,
        before,
    } = branch(entries)?;
    // A prompt Dure sent follows the leaf it was sent at, which may precede
    // the branch's oldest entry in a window.
    let mut next = at_leaf.get(&before).copied();
    let mut context = None;
    let mut items = Vec::new();
    let mut accepted = BTreeMap::new();
    let mut completed = std::collections::BTreeSet::new();
    for entry in selected {
        let id = field(entry, "id")?;
        if entry.get("type").and_then(Value::as_str) == Some("message") {
            let message = entry
                .get("message")
                .ok_or_else(|| protocol_error("Pi message missing"))?;
            let role = field(message, "role")?;
            let at = message
                .get("timestamp")
                .and_then(Value::as_i64)
                .ok_or_else(|| protocol_error("Pi message timestamp missing"))?;
            let mut imported_user = false;
            if role == "user" {
                context = Some(if let Some(owned) = next.take() {
                    accepted.insert(owned.client_message_id.clone(), id.to_owned());
                    owned.clone()
                } else {
                    imported_user = true;
                    TurnContext {
                        turn_id: AgentTurnIdV1::new(format!("pi-turn-{id}"))
                            .map_err(store_error)?,
                        client_message_id: AgentClientMessageIdV1::new(format!("pi-user-{id}"))
                            .map_err(store_error)?,
                    }
                });
            }
            // In a window, the entries before its oldest prompt end a turn
            // whose prompt the window left out. They show without that turn.
            if context.is_some() || before.is_some() {
                let turn = context.as_ref();
                if let Some(context) = turn.filter(|_| role == "user") {
                    items.push(lifecycle(
                        context,
                        AgentTimelineLifecycleStateV1::TurnStarted,
                        at,
                    )?);
                }
                if role != "user" || imported_user {
                    let parts = match message.get("content") {
                        Some(Value::String(text)) if role == "user" => {
                            vec![json!({"type":"text","text":text})]
                        }
                        Some(Value::Array(parts)) => parts.clone(),
                        _ => return Err(protocol_error("Pi message content missing")),
                    };
                    if role == "toolResult" {
                        items.push(item(
                            &format!("entry:{id}:result"),
                            turn,
                            Some(id),
                            AgentTimelineItemBodyV1::Tool {
                                tool_call_id: field(message, "toolCallId")?.into(),
                                name: field(message, "toolName")?.into(),
                                state: if message.get("isError") == Some(&Value::Bool(true)) {
                                    AgentTimelineToolStateV1::Failed
                                } else {
                                    AgentTimelineToolStateV1::Completed
                                },
                                input: None,
                                output: Some(json!(parts)),
                            },
                            at,
                        )?);
                    } else {
                        for (index, part) in parts.iter().enumerate() {
                            let body = match field(part, "type")? {
                                "text" => AgentTimelineItemBodyV1::Message {
                                    role: if role == "user" {
                                        AgentTimelineMessageRoleV1::User
                                    } else {
                                        AgentTimelineMessageRoleV1::Assistant
                                    },
                                    markdown: part
                                        .get("text")
                                        .and_then(Value::as_str)
                                        .ok_or_else(|| protocol_error("Pi text is missing"))?
                                        .into(),
                                },
                                "thinking" => AgentTimelineItemBodyV1::Reasoning {
                                    text: part
                                        .get("thinking")
                                        .and_then(Value::as_str)
                                        .unwrap_or_default()
                                        .into(),
                                },
                                "toolCall" => AgentTimelineItemBodyV1::Tool {
                                    tool_call_id: field(part, "id")?.into(),
                                    name: field(part, "name")?.into(),
                                    state: AgentTimelineToolStateV1::Running,
                                    input: part.get("arguments").cloned(),
                                    output: None,
                                },
                                _ => continue,
                            };
                            items.push(item(
                                &format!("entry:{id}:{index}"),
                                turn,
                                Some(id),
                                body,
                                at,
                            )?);
                        }
                    }
                }
                let terminal = match message.get("stopReason").and_then(Value::as_str) {
                    Some("stop" | "length") => Some(AgentTimelineLifecycleStateV1::TurnCompleted),
                    Some("error" | "aborted") => Some(AgentTimelineLifecycleStateV1::TurnFailed),
                    _ => None,
                };
                if let (Some(state), Some(context)) = (terminal, turn) {
                    completed.insert(context.client_message_id.clone());
                    items.push(lifecycle(context, state, at)?);
                }
            }
        }
        if let Some(anchor) = at_leaf.get(&Some(id)) {
            next = Some(*anchor);
        }
    }
    Ok(ProjectedHistory {
        items,
        accepted,
        completed,
        omits_older: before.is_some(),
    })
}

impl ProjectedHistory {
    /// The items to append, oldest first. A window that `meets_timeline`,
    /// whose items the timeline partly holds, continues its rows. One that
    /// leaves out older history the timeline does not hold opens with the
    /// existing boundary row. The shared transcript reader does not page Pi
    /// sessions, so the row says only that the history is left out, not
    /// where it is.
    pub(super) fn take_items(
        &mut self,
        meets_timeline: bool,
    ) -> Result<Vec<AgentTimelineItemDraftV1>, Error> {
        let mut items = std::mem::take(&mut self.items);
        if let Some(oldest) = items
            .first()
            .filter(|_| self.omits_older && !meets_timeline)
        {
            let boundary = item(
                &format!("history-boundary:{}", oldest.item_id),
                None,
                None,
                AgentTimelineItemBodyV1::HistoryBoundary {
                    reason: PROVIDER_HISTORY_TRUNCATED_BOUNDARY_V1.into(),
                    requested_after_provider_sequence: 0,
                    dropped_through_provider_sequence: 1,
                },
                oldest.created_at_ms,
            )?;
            items.insert(0, boundary);
        }
        Ok(items)
    }
}

pub(super) fn pending_draft(
    request: &Value,
    context: Option<&TurnContext>,
) -> Result<AgentPendingRequestDraftV1, Error> {
    let id = field(request, "id")?;
    let method = field(request, "method")?;
    let (kind, payload) = if method == "confirm" {
        (
            AgentPendingRequestKindV1::Permission,
            json!({"presentation":{"title":request.get("title"),"description":request.get("message")},"providerRequest":request}),
        )
    } else {
        let options = match method {
            "select" => request
                .get("options")
                .and_then(Value::as_array)
                .ok_or_else(|| protocol_error("Pi question options missing"))?
                .iter()
                .map(|option| json!({"label":option}))
                .collect(),
            "input" | "editor" => Vec::new(),
            _ => return Err(protocol_error("Pi question method unsupported")),
        };
        (
            AgentPendingRequestKindV1::Question,
            json!({"input":{"questions":[{"id":"answer","question":request.get("title"),"options":options,"multiSelect":false,"allowOther":matches!(method,"input"|"editor")}]},"providerRequest":request}),
        )
    };
    Ok(AgentPendingRequestDraftV1 {
        request_id: AgentInteractionRequestIdV1::new(format!("pi-{id}")).map_err(store_error)?,
        kind,
        turn_id: context.map(|context| context.turn_id.clone()),
        client_message_id: AgentClientMessageIdV1::new(format!("pi-question-{id}"))
            .map_err(store_error)?,
        payload,
        created_at_ms: 0,
    })
}

pub(super) fn pending_answer(request: &Value, answer: &Value) -> Result<Value, Error> {
    let id = field(request, "id")?;
    if field(request, "method")? == "confirm" {
        return match answer.get("decision").and_then(Value::as_str) {
            Some("allow") => Ok(json!({"id":id,"confirmed":true})),
            Some("deny") => Ok(json!({"id":id,"confirmed":false})),
            _ => Err(protocol_error("Pi confirmation answer invalid")),
        };
    }
    let answer = answer
        .pointer("/answers/answer")
        .and_then(Value::as_str)
        .ok_or_else(|| protocol_error("Pi answer missing"))?;
    if field(request, "method")? == "select"
        && !request
            .get("options")
            .and_then(Value::as_array)
            .is_some_and(|options| options.iter().any(|option| option.as_str() == Some(answer)))
    {
        return Err(protocol_error(
            "Pi selection is outside the offered options",
        ));
    }
    Ok(json!({"id":id,"value":answer}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn follows_exact_leaf_and_rejects_ambiguous_history() {
        let mut entries = Entries {
            entries: vec![
                json!({"id":"a","parentId":null}),
                json!({"id":"b","parentId":"a"}),
                json!({"id":"decoy","parentId":"a"}),
            ],
            leaf_id: Some("b".into()),
            omits_older: false,
        };
        assert_eq!(
            branch(&entries)
                .unwrap()
                .entries
                .iter()
                .map(|entry| entry["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["a", "b"]
        );
        entries.entries[0]["parentId"] = json!("b");
        assert!(branch(&entries).is_err());
        entries.entries[0]["parentId"] = json!("missing");
        assert!(branch(&entries).is_err());
    }
    #[test]
    fn correlates_provider_echo_by_predecessor_and_keeps_imported_string_messages() {
        let context = TurnContext {
            turn_id: AgentTurnIdV1::new("owned-turn").unwrap(),
            client_message_id: AgentClientMessageIdV1::new("owned-client").unwrap(),
        };
        let anchor = PromptAnchor {
            context: context.clone(),
            previous_leaf: Some("before".into()),
            runtime: AgentProviderRuntimeFenceV1 {
                runtime_generation: "runtime".into(),
                provider_epoch: "epoch".into(),
            },
        };
        let anchors = BTreeMap::from([(context.client_message_id.clone(), anchor)]);
        let mut entries = Entries {
            entries: vec![
                json!({"id":"imported","parentId":null,"type":"message","message":{"role":"user","content":"same text","timestamp":1}}),
                json!({"id":"before","parentId":"imported","type":"model_change"}),
                json!({"id":"owned","parentId":"before","type":"message","message":{"role":"user","content":"same text","timestamp":2}}),
                json!({"id":"answer","parentId":"owned","type":"message","message":{"role":"assistant","content":[{"type":"text","text":"answer"}],"stopReason":"stop","timestamp":3}}),
            ],
            leaf_id: Some("answer".into()),
            omits_older: false,
        };
        let history = project(&entries, &anchors).unwrap();
        assert_eq!(
            history
                .accepted
                .get(&context.client_message_id)
                .map(String::as_str),
            Some("owned")
        );
        assert!(history.completed.contains(&context.client_message_id));
        let users = history
            .items
            .iter()
            .filter(|item| {
                matches!(
                    &item.body,
                    AgentTimelineItemBodyV1::Message {
                        role: AgentTimelineMessageRoleV1::User,
                        ..
                    }
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(users.len(), 1);
        assert_eq!(
            users[0].provider_message_id.as_ref().unwrap().as_str(),
            "pi-imported"
        );
        entries.entries.push(json!({"id":"answer","parentId":null}));
        assert!(project(&entries, &anchors).is_err());
    }

    #[test]
    fn uses_common_consent_and_exact_question_answers() {
        let confirm = json!({"id":"confirm","method":"confirm","title":"Continue?","message":"Provider context"});
        let pending = pending_draft(&confirm, None).unwrap();
        assert_eq!(pending.kind, AgentPendingRequestKindV1::Permission);
        assert_eq!(
            pending.payload.pointer("/presentation/description"),
            Some(&json!("Provider context"))
        );
        assert_eq!(
            pending_answer(&confirm, &json!({"decision":"allow"})).unwrap(),
            json!({"id":"confirm","confirmed":true})
        );
        assert_eq!(
            pending_answer(&confirm, &json!({"decision":"deny"})).unwrap(),
            json!({"id":"confirm","confirmed":false})
        );
        assert!(pending_answer(&confirm, &json!({"decision":"unknown"})).is_err());
        let select =
            json!({"id":"select","method":"select","title":"Choose","options":["first","second"]});
        assert!(pending_answer(&select, &json!({"answers":{"answer":"third"}})).is_err());
        assert_eq!(
            pending_answer(&select, &json!({"answers":{"answer":"second"}})).unwrap(),
            json!({"id":"select","value":"second"})
        );
        let input = json!({"id":"input","method":"input","title":"Reply"});
        assert_eq!(
            pending_answer(&input, &json!({"answers":{"answer":"한글\ninput"}})).unwrap(),
            json!({"id":"input","value":"한글\ninput"})
        );
    }

    /// One tool call, tool result or message over the timeline's item bound
    /// fits by the shared rule instead of failing the history, which fails
    /// the attach and every later sync.
    #[test]
    fn oversized_entries_fit_the_timeline_instead_of_failing_the_history() {
        let large = "x".repeat(MAX_AGENT_TIMELINE_JSON_BYTES_V1 + 1);
        let entries = Entries {
            entries: vec![
                json!({"id":"user","parentId":null,"type":"message","message":{"role":"user","content":format!("Paste {large}"),"timestamp":1}}),
                json!({"id":"call","parentId":"user","type":"message","message":{"role":"assistant","content":[{"type":"toolCall","id":"tool-write","name":"write","arguments":{"path":"/fixture/a","content":large}}],"stopReason":"toolUse","timestamp":2}}),
                json!({"id":"result","parentId":"call","type":"message","message":{"role":"toolResult","toolCallId":"tool-write","toolName":"write","content":[{"type":"text","text":large}],"isError":false,"timestamp":3}}),
                json!({"id":"answer","parentId":"result","type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Done"}],"stopReason":"stop","timestamp":4}}),
            ],
            leaf_id: Some("answer".into()),
            omits_older: false,
        };
        let history = project(&entries, &BTreeMap::new()).unwrap();
        let tools = history
            .items
            .iter()
            .filter_map(|item| match &item.body {
                AgentTimelineItemBodyV1::Tool {
                    tool_call_id,
                    input,
                    output,
                    ..
                } => Some((tool_call_id.as_str(), input.is_some(), output.is_some())),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            tools,
            [("tool-write", false, false), ("tool-write", false, false)]
        );
        let texts = history
            .items
            .iter()
            .filter_map(|item| match &item.body {
                AgentTimelineItemBodyV1::Message { markdown, .. } => Some(markdown.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(texts.len(), 2);
        assert!(texts[0].starts_with("Paste xxx") && texts[0].ends_with('…'));
        assert_eq!(texts[1], "Done");
        for item in &history.items {
            item.validate().unwrap();
        }
    }

    /// A session of `turns` answered prompts as Pi appends them: each prompt,
    /// a tool call and its result, then the answer.
    fn session(turns: usize) -> Vec<Value> {
        let mut entries = Vec::new();
        let mut parent = Value::Null;
        for turn in 0..turns {
            let at = turn as i64 * 4;
            let ids = ["prompt", "call", "result", "answer"].map(|kind| format!("{kind}-{turn}"));
            entries.extend([
                json!({"id":ids[0],"parentId":parent,"type":"message","message":{"role":"user","content":format!("Prompt {turn}"),"timestamp":at}}),
                json!({"id":ids[1],"parentId":ids[0],"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","id":format!("tool-{turn}"),"name":"read","arguments":{"path":"a"}}],"stopReason":"toolUse","timestamp":at + 1}}),
                json!({"id":ids[2],"parentId":ids[1],"type":"message","message":{"role":"toolResult","toolCallId":format!("tool-{turn}"),"toolName":"read","content":[{"type":"text","text":"file"}],"isError":false,"timestamp":at + 2}}),
                json!({"id":ids[3],"parentId":ids[2],"type":"message","message":{"role":"assistant","content":[{"type":"text","text":format!("Answer {turn}")}],"stopReason":"stop","timestamp":at + 3}}),
            ]);
            parent = json!(ids[3]);
        }
        entries
    }

    /// The entries of `session` from `start` on, as a window reads them.
    fn window(session: &[Value], start: usize) -> Entries {
        Entries {
            entries: session[start..].to_vec(),
            leaf_id: session
                .last()
                .map(|entry| entry["id"].as_str().unwrap().into()),
            omits_older: start > 0,
        }
    }

    /// Each item as its kind, turn and text, oldest first.
    fn shown(items: &[AgentTimelineItemDraftV1]) -> Vec<String> {
        items
            .iter()
            .map(|item| {
                let turn = item.turn_id.as_ref().map_or("-", |turn| turn.as_str());
                match &item.body {
                    AgentTimelineItemBodyV1::HistoryBoundary { reason, .. } => {
                        format!("boundary {reason}")
                    }
                    AgentTimelineItemBodyV1::Message { markdown, .. } => {
                        format!("{turn} {markdown}")
                    }
                    AgentTimelineItemBodyV1::Tool {
                        tool_call_id,
                        state,
                        ..
                    } => format!("{turn} {tool_call_id} {state:?}"),
                    AgentTimelineItemBodyV1::Lifecycle { state, .. } => {
                        format!("{turn} {state:?}")
                    }
                    other => format!("{turn} {other:?}"),
                }
            })
            .collect()
    }

    /// Appends `items` the way the journal does: each item once, in order.
    fn append(timeline: &mut Vec<AgentTimelineItemDraftV1>, items: Vec<AgentTimelineItemDraftV1>) {
        for item in items {
            if !timeline.iter().any(|held| held.item_id == item.item_id) {
                timeline.push(item);
            }
        }
    }

    /// A window that cuts a turn shows the rest of that turn without it,
    /// then its whole turns, behind one boundary. As Pi appends, each sync
    /// keeps only the turn in progress, and the timeline gets each item once,
    /// in order, as a projection of the whole session gives them.
    #[test]
    fn a_window_opens_behind_a_boundary_and_continues_each_item_once() {
        let whole = session(6);
        let full = project(&window(&whole, 0), &BTreeMap::new()).unwrap();
        assert!(!full.omits_older);

        // The window starts at turn 2's tool result.
        let mut entries = window(&whole[..20], 10);
        let mut history = project(&entries, &BTreeMap::new()).unwrap();
        assert!(history.omits_older);
        let mut timeline = Vec::new();
        append(&mut timeline, history.take_items(false).unwrap());
        assert_eq!(
            shown(&timeline)[..4],
            [
                "boundary provider_history_truncated",
                "- tool-2 Completed",
                "- Answer 2",
                "pi-turn-prompt-3 TurnStarted",
            ]
        );

        // Only the turn in progress stays for the next sync.
        retain_newest_turn(&mut entries).unwrap();
        assert_eq!(entries.entries[0]["id"], "prompt-4");
        assert_eq!(entries.entries.len(), 4);
        assert!(entries.omits_older);

        // Pi appends turn 5. Its window meets the timeline, so no second
        // boundary appears.
        entries.entries.extend_from_slice(&whole[20..]);
        entries.leaf_id = Some("answer-5".into());
        let mut history = project(&entries, &BTreeMap::new()).unwrap();
        assert!(history.omits_older);
        let meets = history
            .items
            .iter()
            .any(|item| timeline.iter().any(|held| held.item_id == item.item_id));
        assert!(meets);
        append(&mut timeline, history.take_items(meets).unwrap());

        // The whole session's turns 3 to 5, unchanged and each once.
        let from = full
            .items
            .iter()
            .position(|item| item.turn_id.as_ref().unwrap().as_str() == "pi-turn-prompt-3")
            .unwrap();
        assert_eq!(timeline[3..], full.items[from..]);
        assert_eq!(
            shown(&timeline)
                .iter()
                .filter(|row| row.starts_with("boundary"))
                .count(),
            1
        );
    }

    /// A prompt Dure sent at the entry right before a window keeps its own
    /// turn, as it does when the whole session is read.
    #[test]
    fn a_prompt_sent_right_before_a_window_keeps_its_turn() {
        let whole = session(3);
        let context = TurnContext {
            turn_id: AgentTurnIdV1::new("dure-turn").unwrap(),
            client_message_id: AgentClientMessageIdV1::new("dure-client").unwrap(),
        };
        let anchors = BTreeMap::from([(
            context.client_message_id.clone(),
            PromptAnchor {
                context: context.clone(),
                previous_leaf: Some("answer-1".into()),
                runtime: AgentProviderRuntimeFenceV1 {
                    runtime_generation: "runtime".into(),
                    provider_epoch: "epoch".into(),
                },
            },
        )]);
        for start in [0, 8] {
            let history = project(&window(&whole, start), &anchors).unwrap();
            assert_eq!(
                history
                    .accepted
                    .get(&context.client_message_id)
                    .map(String::as_str),
                Some("prompt-2")
            );
            assert!(history.completed.contains(&context.client_message_id));
            assert!(history.items.iter().any(|item| {
                item.turn_id.as_ref().map(AgentTurnIdV1::as_str) == Some("dure-turn")
            }));
        }
    }

    /// Pi may append an entry, such as a model change, between the leaf a
    /// prompt Dure sent is anchored at and the prompt itself. Later syncs
    /// still give that prompt its own turn, so it shows once and its turn
    /// completes, with no second boundary.
    #[test]
    fn a_prompt_after_an_entry_pi_appended_keeps_its_turn_across_syncs() {
        let whole = session(2);
        let context = TurnContext {
            turn_id: AgentTurnIdV1::new("dure-turn").unwrap(),
            client_message_id: AgentClientMessageIdV1::new("dure-client").unwrap(),
        };
        let anchors = BTreeMap::from([(
            context.client_message_id.clone(),
            PromptAnchor {
                context: context.clone(),
                previous_leaf: Some("answer-1".into()),
                runtime: AgentProviderRuntimeFenceV1 {
                    runtime_generation: "runtime".into(),
                    provider_epoch: "epoch".into(),
                },
            },
        )]);
        let mut entries = window(&whole, 4);
        let mut timeline = Vec::new();
        let sync = |entries: &mut Entries, timeline: &mut Vec<AgentTimelineItemDraftV1>| {
            let mut history = project(entries, &anchors).unwrap();
            let meets = history
                .items
                .iter()
                .any(|item| timeline.iter().any(|held| held.item_id == item.item_id));
            append(timeline, history.take_items(meets).unwrap());
            retain_newest_turn(entries).unwrap();
            history
        };
        sync(&mut entries, &mut timeline);
        for (newer, leaf) in [
            (
                vec![
                    json!({"id":"model","parentId":"answer-1","type":"model_change"}),
                    json!({"id":"dure-prompt","parentId":"model","type":"message","message":{"role":"user","content":"Dure prompt","timestamp":10}}),
                ],
                "dure-prompt",
            ),
            (
                vec![
                    json!({"id":"dure-answer","parentId":"dure-prompt","type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Dure answer"}],"stopReason":"stop","timestamp":11}}),
                ],
                "dure-answer",
            ),
        ] {
            entries.entries.extend(newer);
            entries.leaf_id = Some(leaf.into());
            let history = sync(&mut entries, &mut timeline);
            assert_eq!(
                history
                    .accepted
                    .get(&context.client_message_id)
                    .map(String::as_str),
                Some("dure-prompt")
            );
        }
        let shown = shown(&timeline);
        assert_eq!(
            shown
                .iter()
                .filter(|row| row.starts_with("boundary"))
                .count(),
            1
        );
        assert_eq!(
            shown[shown.len() - 3..],
            [
                "dure-turn TurnStarted",
                "dure-turn Dure answer",
                "dure-turn TurnCompleted",
            ]
        );
    }

    /// Only a window that leaves out history the timeline does not hold opens
    /// with a boundary. A whole session still needs every parent it names.
    #[test]
    fn only_a_window_that_leaves_history_out_opens_with_a_boundary() {
        let whole = session(2);
        let opens = |start, meets_timeline| {
            let mut history = project(&window(&whole, start), &BTreeMap::new()).unwrap();
            shown(&history.take_items(meets_timeline).unwrap())[0].clone()
        };
        assert_eq!(opens(4, false), "boundary provider_history_truncated");
        assert_eq!(opens(4, true), "pi-turn-prompt-1 TurnStarted");
        assert_eq!(opens(0, false), "pi-turn-prompt-0 TurnStarted");
        let mut empty = project(&window(&whole, 8), &BTreeMap::new()).unwrap();
        assert!(empty.take_items(false).unwrap().is_empty());
        let mut cut = window(&whole, 4);
        cut.omits_older = false;
        assert!(project(&cut, &BTreeMap::new()).is_err());
    }
}
