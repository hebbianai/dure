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
        body,
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

/// Follow parent IDs from the explicit leaf. Append order also contains forks;
/// it is not the selected conversation branch and must never seed a transcript.
pub(super) fn branch(entries: &Entries) -> Result<Vec<&Value>, Error> {
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
        let entry = *by_id
            .get(id)
            .ok_or_else(|| protocol_error("Pi branch has a missing parent"))?;
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
    Ok(selected)
}

pub(super) struct ProjectedHistory {
    pub(super) items: Vec<AgentTimelineItemDraftV1>,
    pub(super) accepted: BTreeMap<AgentClientMessageIdV1, String>,
    pub(super) completed: std::collections::BTreeSet<AgentClientMessageIdV1>,
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
    let mut next = at_leaf.get(&None).copied();
    let mut context = None;
    let mut items = Vec::new();
    let mut accepted = BTreeMap::new();
    let mut completed = std::collections::BTreeSet::new();
    for entry in branch(entries)? {
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
            if let Some(context) = &context {
                if role == "user" {
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
                            Some(context),
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
                                Some(context),
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
                if let Some(state) = terminal {
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
    })
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
        };
        assert_eq!(
            branch(&entries)
                .unwrap()
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
}
