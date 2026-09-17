//! Forward native sharing to the connector that already owns delivery state.

use super::*;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Request {
    team_id: String,
    request_id: String,
    agent_id: String,
    channel_id: String,
    interaction_session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    backend: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Descriptor {
    schema_version: u16,
    kind: String,
    team_id: String,
    port: u16,
    token: String,
}

pub(super) async fn send(root: &Path, request: Request) -> Result<Value, BackendDispatchError> {
    if !valid_team(&request.team_id) {
        return Err(error("slack_connection_workspace_invalid"));
    }
    let file = root
        .join(&request.team_id)
        .join("config.json.connector.json");
    let source = private_record::read_bounded(&file, 64 * 1024)
        .map_err(|_| error("slack_share_connector_unavailable"))?
        .ok_or_else(|| error("slack_share_connector_unavailable"))?;
    let descriptor: Descriptor =
        serde_json::from_slice(&source).map_err(|_| error("slack_share_connector_unavailable"))?;
    if descriptor.schema_version != 1
        || descriptor.kind != "dure.slack.connector"
        || descriptor.team_id != request.team_id
        || descriptor.port == 0
        || descriptor.token.is_empty()
    {
        return Err(error("slack_share_connector_unavailable"));
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .retry(reqwest::retry::never())
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|_| error("slack_share_failed"))?;
    let mut body = serde_json::to_value(request).map_err(|_| error("slack_share_failed"))?;
    body["schemaVersion"] = json!(1);
    let response = client
        .post(format!("http://127.0.0.1:{}/slack/share", descriptor.port))
        .bearer_auth(descriptor.token)
        .json(&body)
        .send()
        .await
        .map_err(|_| error("slack_share_failed"))?;
    let successful = response.status().is_success();
    let envelope: Value = response
        .json()
        .await
        .map_err(|_| error("slack_share_failed"))?;
    if successful && envelope["ok"] == true {
        return Ok(json!({ "schemaVersion": 1, "share": envelope["result"] }));
    }
    let code = envelope["error"]["code"]
        .as_str()
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 80
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
        })
        .unwrap_or("slack_share_failed");
    Err(error(code))
}
