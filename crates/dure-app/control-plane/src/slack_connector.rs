//! The backend owns connection settings and the connector process. Slack task
//! delivery remains in the existing CLI adapter and its single-writer journal.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Weak};
#[cfg(test)]
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{Mutex, watch};

use crate::{
    BackendDispatchError, HmuxToolchainIdentity, ServiceState, ensure_owner_subdirectory,
    private_record, pro_features, random_opaque_reference,
};

pub(crate) const OPERATION: &str = "slack.connector";

mod share;
mod tasks;

#[cfg(test)]
mod tests;

#[derive(Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Configuration {
    schema_version: u16,
    team_id: String,
    channels: Vec<Channel>,
}

#[derive(Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Channel {
    channel_id: String,
    project_id: String,
    provider_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    backend: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    objective: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    space: Option<String>,
}

// Never derive Debug or return this private record through the API.
#[derive(Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    schema_version: u16,
    config: Configuration,
    app_token: Option<String>,
    bot_token: Option<String>,
    enabled: bool,
    failure: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Action {
    List,
    Tasks {
        #[serde(rename = "teamId")]
        team_id: String,
    },
    Share {
        #[serde(flatten)]
        request: share::Request,
    },
    Connect {
        config: Configuration,
        #[serde(default, rename = "appToken")]
        app_token: Option<String>,
        #[serde(default, rename = "botToken")]
        bot_token: Option<String>,
    },
    Disconnect {
        #[serde(rename = "teamId")]
        team_id: String,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    schema_version: u16,
    #[serde(flatten)]
    action: Action,
}

struct Running {
    owner: Option<ChildStdin>,
    complete: watch::Receiver<bool>,
}

struct Connection {
    settings: Settings,
    generation: Option<String>,
    state: &'static str,
    failure: Option<String>,
    stopping: bool,
    running: Option<Running>,
}

impl Connection {
    fn saved(settings: Settings) -> Self {
        Self {
            state: if settings.failure.is_some() {
                "failed"
            } else {
                "stopped"
            },
            failure: settings.failure.clone(),
            settings,
            generation: None,
            stopping: false,
            running: None,
        }
    }

    fn view(&self) -> Value {
        json!({
            "config": self.settings.config,
            "enabled": self.settings.enabled,
            "credentialsConfigured": self.settings.app_token.is_some()
                && self.settings.bot_token.is_some(),
            "connection": self.state,
            "generation": self.generation,
            "failure": self.failure,
        })
    }
}

#[derive(Default)]
struct Connections {
    loaded: bool,
    entries: BTreeMap<String, Connection>,
}

pub(crate) struct SlackConnectorService {
    root: PathBuf,
    home: PathBuf,
    cli: PathBuf,
    hmux: HmuxToolchainIdentity,
    // Management operations serialize with retirement. Child observations use
    // a separate lock, so status and completion remain available while stopping.
    commands: Mutex<()>,
    connections: Arc<Mutex<Connections>>,
}

fn error(code: &str) -> BackendDispatchError {
    BackendDispatchError::terminal(code)
}

fn valid_team(team: &str) -> bool {
    team.len() > 1
        && team.len() <= 64
        && team.starts_with('T')
        && team
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
}

impl SlackConnectorService {
    pub(crate) fn new(
        backend_root: &Path,
        home: &Path,
        cli: PathBuf,
        hmux: HmuxToolchainIdentity,
    ) -> Self {
        Self {
            root: backend_root.join("slack"),
            home: home.to_path_buf(),
            cli,
            hmux,
            commands: Mutex::new(()),
            connections: Arc::new(Mutex::new(Connections::default())),
        }
    }

    async fn load(&self) -> Result<(), BackendDispatchError> {
        let mut connections = self.connections.lock().await;
        if connections.loaded {
            return Ok(());
        }
        let root = ensure_owner_subdirectory(self.root.parent().expect("backend root"), "slack")
            .map_err(|_| error("slack_connection_storage_unavailable"))?;
        let mut entries = BTreeMap::new();
        for entry in
            std::fs::read_dir(root).map_err(|_| error("slack_connection_storage_unavailable"))?
        {
            let entry = entry.map_err(|_| error("slack_connection_storage_unavailable"))?;
            let team = entry.file_name().to_string_lossy().into_owned();
            if !valid_team(&team) {
                continue;
            }
            let directory = ensure_owner_subdirectory(&self.root, &team)
                .map_err(|_| error("slack_connection_storage_unavailable"))?;
            let Some(source) =
                private_record::read_bounded(&directory.join("settings.json"), 256 * 1024)
                    .map_err(|_| error("slack_connection_storage_unavailable"))?
            else {
                continue;
            };
            let settings: Settings = serde_json::from_slice(&source)
                .map_err(|_| error("slack_connection_settings_invalid"))?;
            if settings.schema_version != 1 || settings.config.team_id != team {
                return Err(error("slack_connection_settings_invalid"));
            }
            entries.insert(team, Connection::saved(settings));
        }
        connections.entries = entries;
        connections.loaded = true;
        Ok(())
    }

    fn save(&self, settings: &Settings) -> Result<(), BackendDispatchError> {
        let directory = ensure_owner_subdirectory(&self.root, &settings.config.team_id)
            .map_err(|_| error("slack_connection_storage_unavailable"))?;
        private_record::write(&directory.join("settings.json"), settings)
            .map_err(|_| error("slack_connection_save_failed"))
    }

    async fn snapshot(&self) -> Value {
        let connections = self.connections.lock().await;
        json!({ "schemaVersion": 1, "connections": connections.entries.values().map(Connection::view).collect::<Vec<_>>() })
    }

    pub(crate) async fn dispatch(&self, body: &Value) -> Result<Value, BackendDispatchError> {
        if !pro_features::development_previews_available() {
            return Err(error("slack_pro_development_only"));
        }
        let request: Request = serde_json::from_value(body.clone())
            .map_err(|_| error("slack_connection_request_invalid"))?;
        if request.schema_version != 1 {
            return Err(error("slack_connection_request_invalid"));
        }
        if let Action::Tasks { ref team_id } = request.action {
            return tasks::list(&self.root, team_id);
        }
        if let Action::Share { request } = request.action {
            return share::send(&self.root, request).await;
        }
        self.load().await?;
        if matches!(request.action, Action::List) {
            return Ok(self.snapshot().await);
        }
        let _command = self.commands.lock().await;
        match request.action {
            Action::List | Action::Share { .. } | Action::Tasks { .. } => {}
            Action::Connect {
                config,
                app_token,
                bot_token,
            } => {
                if config.schema_version != 1 {
                    return Err(error("slack_connection_request_invalid"));
                }
                if !valid_team(&config.team_id) {
                    return Err(error("slack_connection_workspace_invalid"));
                }
                let team = config.team_id.clone();
                let previous = self
                    .connections
                    .lock()
                    .await
                    .entries
                    .get(&team)
                    .map(|entry| entry.settings.clone());
                let settings = Settings {
                    schema_version: 1,
                    config,
                    app_token: app_token
                        .or_else(|| previous.as_ref().and_then(|saved| saved.app_token.clone())),
                    bot_token: bot_token
                        .or_else(|| previous.as_ref().and_then(|saved| saved.bot_token.clone())),
                    enabled: true,
                    failure: None,
                };
                let unchanged = self
                    .connections
                    .lock()
                    .await
                    .entries
                    .get(&team)
                    .is_some_and(|entry| {
                        entry.settings == settings
                            && entry.running.is_some()
                            && !entry.stopping
                            && entry.state != "failed"
                    });
                if !unchanged {
                    self.stop(&team, Some(settings)).await?;
                    self.start(&team).await?;
                }
            }
            Action::Disconnect { team_id } => {
                let settings = {
                    let connections = self.connections.lock().await;
                    let entry = connections
                        .entries
                        .get(&team_id)
                        .ok_or_else(|| error("slack_connection_missing"))?;
                    let mut settings = entry.settings.clone();
                    settings.enabled = false;
                    settings.failure = None;
                    settings
                };
                self.stop(&team_id, Some(settings)).await?;
            }
        }
        Ok(self.snapshot().await)
    }

    async fn start(&self, team: &str) -> Result<(), BackendDispatchError> {
        let mut connections = self.connections.lock().await;
        let entry = connections
            .entries
            .get_mut(team)
            .ok_or_else(|| error("slack_connection_missing"))?;
        if entry.running.is_some() {
            return Ok(());
        }
        let directory = self.root.join(team);
        let config = directory.join("config.json");
        // Runtime input is a projection of the private settings record. The
        // adapter never receives credentials in its configuration or journal.
        private_record::write(&config, &entry.settings.config)
            .map_err(|_| error("slack_connection_save_failed"))?;
        let generation = random_opaque_reference("slack-connector")?;
        let mut command = tokio::process::Command::new(&self.cli);
        command
            .args(["slack", "serve", "--config"])
            .arg(&config)
            .args(["--backend", "local", "--owner-lifetime", "stdin"])
            .current_dir(&directory)
            .env("DURE_HOME", &self.home)
            .env("DURE_HMUX_BIN", &self.hmux.executable_path)
            .env("DURE_HMUX_RUNTIME_BIN", &self.hmux.runtime_executable_path)
            .env("HMUX_DISCOVERY_ROOT", &self.hmux.discovery_root)
            .env_remove("DURE_SLACK_APP_TOKEN")
            .env_remove("DURE_SLACK_BOT_TOKEN")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        if let Some(token) = &entry.settings.app_token {
            command.env("DURE_SLACK_APP_TOKEN", token);
        }
        if let Some(token) = &entry.settings.bot_token {
            command.env("DURE_SLACK_BOT_TOKEN", token);
        }
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(_) => {
                entry.state = "failed";
                entry.failure = Some("slack_connector_launch_failed".into());
                entry.settings.enabled = false;
                entry.settings.failure = entry.failure.clone();
                self.save(&entry.settings)?;
                return Ok(());
            }
        };
        let owner = child
            .stdin
            .take()
            .ok_or_else(|| error("slack_connector_owner_unavailable"))?;
        let (complete, finished) = watch::channel(false);
        entry.generation = Some(generation.clone());
        entry.state = "connecting";
        entry.failure = None;
        entry.stopping = false;
        entry.running = Some(Running {
            owner: Some(owner),
            complete: finished,
        });
        tokio::spawn(observe_child(
            child,
            Arc::downgrade(&self.connections),
            directory,
            team.to_owned(),
            generation,
            complete,
        ));
        Ok(())
    }

    async fn stop(
        &self,
        team: &str,
        settings: Option<Settings>,
    ) -> Result<(), BackendDispatchError> {
        let finished = {
            let mut connections = self.connections.lock().await;
            if let Some(settings) = settings {
                // Persist the requested replacement before closing the old
                // owner pipe. Its late observations cannot overwrite this intent.
                self.save(&settings)?;
                match connections.entries.get_mut(team) {
                    Some(entry) => entry.settings = settings,
                    None => {
                        connections
                            .entries
                            .insert(team.to_owned(), Connection::saved(settings));
                    }
                }
            }
            let Some(entry) = connections.entries.get_mut(team) else {
                return Ok(());
            };
            if let Some(running) = entry.running.as_mut() {
                entry.stopping = true;
                entry.state = "stopping";
                drop(running.owner.take());
                Some(running.complete.clone())
            } else {
                entry.state = if entry.settings.failure.is_some() {
                    "failed"
                } else {
                    "stopped"
                };
                entry.failure = entry.settings.failure.clone();
                None
            }
        };
        if let Some(mut finished) = finished {
            while !*finished.borrow_and_update() {
                finished
                    .changed()
                    .await
                    .map_err(|_| error("slack_connector_stop_unconfirmed"))?;
            }
        }
        Ok(())
    }

    async fn restore(&self) -> Result<(), BackendDispatchError> {
        let _command = self.commands.lock().await;
        self.load().await?;
        let teams: Vec<_> = self
            .connections
            .lock()
            .await
            .entries
            .iter()
            .filter(|(_, entry)| entry.settings.enabled)
            .map(|(team, _)| team.clone())
            .collect();
        for team in teams {
            self.start(&team).await?;
        }
        Ok(())
    }

    pub(crate) async fn shutdown(&self) -> Result<(), BackendDispatchError> {
        let _command = self.commands.lock().await;
        let teams: Vec<_> = self
            .connections
            .lock()
            .await
            .entries
            .keys()
            .cloned()
            .collect();
        for team in teams {
            self.stop(&team, None).await?;
        }
        Ok(())
    }
}

async fn observe_child(
    mut child: Child,
    connections: Weak<Mutex<Connections>>,
    directory: PathBuf,
    team: String,
    generation: String,
    complete: watch::Sender<bool>,
) {
    let mut failure = None;
    if let Some(stdout) = child.stdout.take() {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(event) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let state = match event["event"].as_str() {
                Some("slack.connecting") => "connecting",
                Some("slack.connected") => "connected",
                Some("slack.disconnected") => "disconnected",
                Some("slack.failed") => {
                    failure = event["code"]
                        .as_str()
                        .filter(|code| {
                            code.len() <= 80
                                && code
                                    .bytes()
                                    .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
                        })
                        .map(str::to_owned);
                    "failed"
                }
                _ => continue,
            };
            let Some(connections) = connections.upgrade() else {
                break;
            };
            let mut connections = connections.lock().await;
            if let Some(entry) = connections
                .entries
                .get_mut(&team)
                .filter(|entry| entry.generation.as_deref() == Some(&generation) && !entry.stopping)
            {
                entry.state = state;
                entry.failure = failure.clone();
            }
        }
    }
    let outcome = child.wait().await;
    if let Some(connections) = connections.upgrade() {
        let mut connections = connections.lock().await;
        if let Some(entry) = connections
            .entries
            .get_mut(&team)
            .filter(|entry| entry.generation.as_deref() == Some(&generation))
        {
            let requested_stop = entry.stopping;
            let stopped = requested_stop && outcome.is_ok_and(|status| status.success());
            entry.state = if stopped { "stopped" } else { "failed" };
            entry.running = None;
            entry.stopping = false;
            entry.failure = if stopped {
                None
            } else {
                Some(failure.unwrap_or_else(|| "slack_connector_exited".into()))
            };
            if !requested_stop {
                entry.settings.enabled = false;
                entry.settings.failure = entry.failure.clone();
                if private_record::write(&directory.join("settings.json"), &entry.settings).is_err()
                {
                    entry.failure = Some("slack_connection_save_failed".into());
                }
            }
        }
    }
    complete.send_replace(true);
}

pub(crate) async fn restore_when_active(state: Arc<ServiceState>) {
    if !pro_features::development_previews_available() {
        return;
    }
    state.wait_for_mutation_authority().await;
    let _ = state.slack.restore().await;
}
