//! Project links from the connector's journal; task state remains in the agent service.

use super::*;

pub(super) fn list(root: &Path, team_id: &str) -> Result<Value, BackendDispatchError> {
    if !valid_team(team_id) {
        return Err(error("slack_connection_workspace_invalid"));
    }
    let file = root.join(team_id).join("config.json.deliveries.json");
    let source = private_record::read_bounded(&file, 16 * 1024 * 1024)
        .map_err(|_| error("slack_tasks_unavailable"))?;
    let Some(source) = source else {
        return Ok(json!({ "schemaVersion": 1, "tasks": [] }));
    };
    project(&source, team_id)
}

fn project(source: &[u8], team_id: &str) -> Result<Value, BackendDispatchError> {
    let journal: Value = serde_json::from_slice(source)
        .map_err(|_| error("slack_tasks_unavailable"))?;
    if journal["schemaVersion"] != 2 {
        return Err(error("slack_tasks_unavailable"));
    }
    let threads = journal["threads"].as_object()
        .ok_or_else(|| error("slack_tasks_unavailable"))?;
    let mut tasks = Vec::new();
    for (key, thread) in threads {
        if thread["teamId"] != team_id {
            return Err(error("slack_tasks_unavailable"));
        }
        // Accepted messages can precede a confirmed agent launch.
        if !thread["agentId"].is_string() { continue; }
        // A short public thread opener labels the link; private chat history
        // and delivery state never become sidebar content.
        let title = journal["inbox"].as_object().into_iter().flat_map(|inbox| inbox.values())
            .find(|entry| entry["message"]["threadKey"].as_str() == Some(key.as_str())
                && entry["message"]["messageTs"] == thread["threadTs"])
            .and_then(|entry| entry["message"]["text"].as_str())
            .map(|text| text.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(120).collect::<String>());
        tasks.push(json!({
            "title": title,
            "teamId": team_id,
            "channelId": thread["channelId"],
            "threadTs": thread["threadTs"],
            "agentId": thread["agentId"],
            "interactionSessionId": thread["interactionSessionId"],
            "projectId": thread["route"]["projectId"],
            "backend": thread["backend"],
        }));
    }
    tasks.sort_by(|left, right| right["threadTs"].as_str().cmp(&left["threadTs"].as_str()));
    Ok(json!({ "schemaVersion": 1, "tasks": tasks }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clients_observe_the_same_links_without_copying_private_delivery_content() {
        let source = serde_json::to_vec(&json!({
            "schemaVersion": 2,
            "inbox": { "private": "message content", "opener": { "message": {
                "threadKey": "a", "messageTs": "123.456", "text": "A shared\n  public brief"
            }}, "later": { "message": {
                "threadKey": "a", "messageTs": "124.456", "text": "private delivery follow-up"
            }} },
            "threads": {
                "a": { "teamId": "T1", "agentId": "agent-a", "channelId": "C1",
                    "threadTs": "123.456", "interactionSessionId": "conversation-a",
                    "route": { "projectId": "project-a" },
                    "backend": { "profileId": "local", "backendId": "backend-a", "scopeId": "scope-a" },
                    "cursor": { "private": "delivery cursor" } },
                "queued": { "teamId": "T1", "agentId": null }
            }
        })).unwrap();
        let first = project(&source, "T1").unwrap();
        let second = project(&source, "T1").unwrap();
        assert_eq!(first, second);
        assert_eq!(first["tasks"].as_array().unwrap().len(), 1);
        assert_eq!(first["tasks"][0]["agentId"], "agent-a");
        assert_eq!(first["tasks"][0]["title"], "A shared public brief");
        assert!(!first.to_string().contains("private"));
        assert!(project(&source, "T2").is_err());
        assert!(project(b"broken", "T1").is_err());
    }
}
