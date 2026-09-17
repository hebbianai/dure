use super::*;

#[derive(Clone)]
pub(super) struct TurnContext {
    pub(super) turn_id: AgentTurnIdV1,
    pub(super) client_message_id: AgentClientMessageIdV1,
}

pub(super) fn field<'a>(value: &'a Value, key: &str) -> Result<&'a str, CommandError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| protocol_error("provider message is missing a required field"))
}

fn context(id: &str) -> Result<TurnContext, CommandError> {
    Ok(TurnContext {
        turn_id: AgentTurnIdV1::new(format!("opencode-turn-{id}")).map_err(store_error)?,
        client_message_id: AgentClientMessageIdV1::new(format!("opencode-user-{id}"))
            .map_err(store_error)?,
    })
}

pub(super) fn item(
    key: &str,
    context: Option<&TurnContext>,
    provider_id: Option<&str>,
    body: AgentTimelineItemBodyV1,
    created_at_ms: i64,
) -> Result<AgentTimelineItemDraftV1, CommandError> {
    let item = AgentTimelineItemDraftV1 {
        item_id: AgentTimelineItemIdV1::new(format!("opencode-{}", digest(key)))
            .map_err(store_error)?,
        turn_id: context.map(|context| context.turn_id.clone()),
        client_message_id: context.map(|context| context.client_message_id.clone()),
        provider_message_id: provider_id
            .map(|id| AgentProviderMessageIdV1::new(format!("opencode-{id}")).map_err(store_error))
            .transpose()?,
        body,
        created_at_ms,
    };
    item.validate().map_err(store_error)?;
    Ok(item)
}

pub(super) fn lifecycle(
    user: &str,
    context: &TurnContext,
    state: AgentTimelineLifecycleStateV1,
    at: i64,
) -> Result<AgentTimelineItemDraftV1, CommandError> {
    item(
        &format!("turn:{user}:{state:?}"),
        Some(context),
        None,
        AgentTimelineItemBodyV1::Lifecycle {
            state,
            detail: None,
        },
        at,
    )
}

pub(super) fn message_items(
    message: &Value,
    turns: &mut BTreeMap<String, TurnContext>,
) -> Result<(Vec<AgentTimelineItemDraftV1>, Option<String>), CommandError> {
    let info = message
        .get("info")
        .ok_or_else(|| protocol_error("message info missing"))?;
    let id = field(info, "id")?;
    let role = field(info, "role")?;
    let created = info
        .pointer("/time/created")
        .and_then(Value::as_i64)
        .ok_or_else(|| protocol_error("message timestamp missing"))?;
    let user = if role == "user" {
        id
    } else {
        field(info, "parentID")?
    };
    if !turns.contains_key(user) {
        turns.insert(user.into(), context(user)?);
    }
    let context = turns
        .get(user)
        .ok_or_else(|| protocol_error("turn context missing"))?;
    let mut items = Vec::new();
    if role == "user" {
        items.push(lifecycle(
            user,
            context,
            AgentTimelineLifecycleStateV1::TurnStarted,
            created,
        )?);
        // Dure already journals its user input before the provider effect.
        if user_message_id(&context.client_message_id) == id {
            return Ok((items, None));
        }
    }
    for part in message
        .get("parts")
        .and_then(Value::as_array)
        .ok_or_else(|| protocol_error("message parts missing"))?
    {
        let part_id = field(part, "id")?;
        let at = part
            .pointer("/time/start")
            .and_then(Value::as_i64)
            .unwrap_or(created);
        let complete =
            info.pointer("/time/completed").is_some() || part.pointer("/time/end").is_some();
        let body = match field(part, "type")? {
            "text"
                if part.get("ignored") != Some(&Value::Bool(true))
                    && (role == "user" || complete) =>
            {
                AgentTimelineItemBodyV1::Message {
                    role: if role == "user" {
                        AgentTimelineMessageRoleV1::User
                    } else {
                        AgentTimelineMessageRoleV1::Assistant
                    },
                    markdown: part
                        .get("text")
                        .and_then(Value::as_str)
                        .ok_or_else(|| protocol_error("text part missing text"))?
                        .into(),
                }
            }
            "reasoning" if complete => AgentTimelineItemBodyV1::Reasoning {
                text: part
                    .get("text")
                    .and_then(Value::as_str)
                    .ok_or_else(|| protocol_error("reasoning part missing text"))?
                    .into(),
            },
            "tool" => {
                let state = part
                    .get("state")
                    .ok_or_else(|| protocol_error("tool state missing"))?;
                AgentTimelineItemBodyV1::Tool {
                    tool_call_id: field(part, "callID")?.into(),
                    name: field(part, "tool")?.into(),
                    state: match field(state, "status")? {
                        "pending" | "running" => AgentTimelineToolStateV1::Running,
                        "completed" => AgentTimelineToolStateV1::Completed,
                        "error" => AgentTimelineToolStateV1::Failed,
                        _ => return Err(protocol_error("unknown tool state")),
                    },
                    input: state.get("input").cloned(),
                    output: state.get("output").or_else(|| state.get("error")).cloned(),
                }
            }
            _ => continue,
        };
        let key = match &body {
            AgentTimelineItemBodyV1::Tool { state, .. } => format!("part:{part_id}:{state:?}"),
            _ => format!("part:{part_id}"),
        };
        items.push(item(&key, Some(context), Some(part_id), body, at)?);
    }
    let completed = info.pointer("/time/completed").and_then(Value::as_i64);
    let terminal = if info.get("error").is_some_and(|error| !error.is_null()) {
        Some(AgentTimelineLifecycleStateV1::TurnFailed)
    } else if completed.is_some()
        && matches!(
            info.get("finish").and_then(Value::as_str),
            Some("stop" | "length" | "content-filter")
        )
    {
        Some(AgentTimelineLifecycleStateV1::TurnCompleted)
    } else {
        None
    };
    if let Some(state) = terminal {
        items.push(lifecycle(
            user,
            context,
            state,
            completed.unwrap_or(created),
        )?);
        return Ok((items, Some(user.into())));
    }
    Ok((items, None))
}

pub(super) fn pending_draft(
    kind: PendingKind,
    request: &Value,
) -> Result<AgentPendingRequestDraftV1, CommandError> {
    let id = field(request, "id")?;
    let payload = match kind {
        PendingKind::Permission => json!({
            "presentation": {"title": request.get("permission"), "description": request.get("patterns").map(Value::to_string)},
            "providerRequest": request,
        }),
        PendingKind::Question => {
            let questions = request
                .get("questions")
                .and_then(Value::as_array)
                .ok_or_else(|| protocol_error("questions missing"))?;
            json!({"input": {"questions": questions.iter().enumerate().map(|(index, question)| json!({
                "id": format!("q{index}"), "question": question.get("question"), "header": question.get("header"), "options": question.get("options"),
                "multiSelect": false, "allowOther": question.get("custom").and_then(Value::as_bool).unwrap_or(true),
            })).collect::<Vec<_>>()}, "providerRequest": request})
        }
    };
    Ok(AgentPendingRequestDraftV1 {
        request_id: AgentInteractionRequestIdV1::new(format!("opencode-{id}"))
            .map_err(store_error)?,
        kind: match kind {
            PendingKind::Permission => AgentPendingRequestKindV1::Permission,
            PendingKind::Question => AgentPendingRequestKindV1::Question,
        },
        turn_id: None,
        client_message_id: AgentClientMessageIdV1::new(format!("opencode-request-{id}"))
            .map_err(store_error)?,
        payload,
        created_at_ms: 0,
    })
}

pub(super) fn pending_answer(
    kind: PendingKind,
    request: &Value,
    answer: &Value,
) -> Result<Value, CommandError> {
    match kind {
        PendingKind::Permission => match answer.get("decision").and_then(Value::as_str) {
            Some("allow") => Ok(json!({"reply":"once"})),
            Some("deny") => Ok(json!({"reply":"reject"})),
            _ => Err(protocol_error("permission decision missing")),
        },
        PendingKind::Question => {
            let count = request
                .get("questions")
                .and_then(Value::as_array)
                .ok_or_else(|| protocol_error("questions missing"))?
                .len();
            let submitted = answer
                .get("answers")
                .and_then(Value::as_object)
                .ok_or_else(|| protocol_error("question answers missing"))?;
            let answers = (0..count)
                .map(|index| {
                    submitted
                        .get(&format!("q{index}"))
                        .and_then(Value::as_str)
                        .map(|answer| vec![answer.to_owned()])
                        .ok_or_else(|| protocol_error("question answer missing"))
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(json!({"answers": answers}))
        }
    }
}

#[cfg(test)]
mod tests;
