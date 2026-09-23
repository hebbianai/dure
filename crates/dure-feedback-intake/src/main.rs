//! Process entry point: reads configuration from the environment, wires the
//! real GitHub/Telegram-backed feedback sink, and serves the intake HTTP
//! surface.
//!
//! Fail closed on GitHub: a process that accepts feedback but can never
//! record it is worse than one that refuses to start, so `GITHUB_TOKEN` and
//! `GITHUB_ASSETS_TOKEN` (two separate credentials — see
//! `GithubTelegramConfig`'s doc comment for why) are both checked here
//! before the server binds — see `required_env` below, and boot-time
//! *validity* checks (`credential_verdict`) below that. Presence alone was
//! not enough: a lapsed `GITHUB_ASSETS_TOKEN` announces nothing at request
//! time either, because attachment upload failures are non-fatal to
//! delivery (an earlier ruling), so an intake with an expired assets
//! credential would run indefinitely while every screenshot silently failed
//! to commit. A screenshot is evidence, not convenience, so the assets
//! credential is checked exactly as strictly as the issues one. Telegram
//! credentials are optional: the issue is the durable record and Telegram
//! is only a best-effort convenience ping, so a deployment must be able to
//! boot (and deliver) before a Telegram bot even exists.

use std::env;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::SystemTime;

use dure_feedback_intake::github::{CredentialCheck, GithubClient};
use dure_feedback_intake::http::{AppState, router};
use dure_feedback_intake::limits::RateLimiter;
use dure_feedback_intake::sink::{GithubTelegramConfig, GithubTelegramSink};

const DEFAULT_GITHUB_API_BASE: &str = "https://api.github.com";
const DEFAULT_TELEGRAM_API_BASE: &str = "https://api.telegram.org";

/// Reads a required environment variable, or exits the process loudly.
/// Delivery credentials are not optional: a running server that can only
/// ever fail delivery is worse than one that never started.
fn required_env(key: &str) -> String {
    env::var(key).unwrap_or_else(|_| {
        eprintln!("{key} is not set; refusing to start the feedback intake");
        std::process::exit(1);
    })
}

/// What a boot-time [`CredentialCheck`] means for whether the process should
/// keep starting, named after `env_var_name` so the eventual message points
/// an operator at exactly the variable to fix.
#[derive(Debug, PartialEq, Eq)]
enum CredentialVerdict {
    /// Nothing to say, nothing to do.
    Silent,
    /// Not evidence against the credential (a timeout, a 5xx, a transport
    /// error) — log loudly and keep booting. A GitHub outage must not stop
    /// the intake from starting; the first real submission will surface a
    /// genuine problem.
    Warn(String),
    /// A definitive 401/403 (bad/revoked/expired) or 404 (wrong repository
    /// selection) — refuse to start, the same posture as a missing
    /// variable.
    Fatal(String),
}

fn credential_verdict(env_var_name: &str, check: CredentialCheck) -> CredentialVerdict {
    match check {
        CredentialCheck::Valid => CredentialVerdict::Silent,
        CredentialCheck::Invalid => CredentialVerdict::Fatal(format!(
            "{env_var_name} was rejected by GitHub (401/403) — it is missing, revoked, or \
             expired; refusing to start the feedback intake"
        )),
        CredentialCheck::RepositoryNotVisible => CredentialVerdict::Fatal(format!(
            "{env_var_name} cannot see its repository (404) — likely minted against the wrong \
             resource owner or repository selection; refusing to start the feedback intake"
        )),
        CredentialCheck::Unverifiable(reason) => CredentialVerdict::Warn(format!(
            "could not verify {env_var_name} at startup ({reason}); starting anyway — a GitHub \
             outage must not block boot, but this credential is unverified until the first real \
             submission"
        )),
    }
}

/// Logs (nothing, a warning, or a fatal message — never the credential's
/// value) and exits the process for a [`CredentialVerdict::Fatal`].
fn apply_credential_verdict(verdict: CredentialVerdict) {
    match verdict {
        CredentialVerdict::Silent => {}
        CredentialVerdict::Warn(message) => eprintln!("{message}"),
        CredentialVerdict::Fatal(message) => {
            eprintln!("{message}");
            std::process::exit(1);
        }
    }
}

#[tokio::main]
async fn main() {
    let github_token = required_env("GITHUB_TOKEN");
    let github_assets_token = required_env("GITHUB_ASSETS_TOKEN");

    // Base URLs default to the real hosts; overriding them is only for
    // pointing the process at a mock server (tests, staging rehearsals).
    let github_api_base =
        env::var("GITHUB_API_BASE").unwrap_or_else(|_| DEFAULT_GITHUB_API_BASE.to_string());

    // Boot-time validity, not just presence: one lightweight authenticated
    // GET per token against the repository it is scoped to. This client is
    // used only for the check and then dropped — `GithubTelegramSink`
    // builds its own from the same config, deliberately: the check belongs
    // here, not inside the sink's constructor, so sink-level tests never
    // need a live server merely to construct one.
    let credential_check_client = GithubClient::new(
        reqwest::Client::new(),
        github_api_base.clone(),
        github_token.clone(),
        github_assets_token.clone(),
    );
    apply_credential_verdict(credential_verdict(
        "GITHUB_TOKEN",
        credential_check_client.check_issues_credential().await,
    ));
    apply_credential_verdict(credential_verdict(
        "GITHUB_ASSETS_TOKEN",
        credential_check_client.check_assets_credential().await,
    ));

    // Telegram is optional: unlike the two GitHub credentials, neither
    // variable gates startup. When either is missing, `GithubTelegramSink`
    // treats notification as configured-off and every notification attempt
    // is a silent no-op — so an operator gets exactly one warning here, up
    // front, rather than a service that refuses to boot before a Telegram
    // bot exists, or one that silently never notifies with no explanation.
    let telegram_token = env::var("TELEGRAM_BOT_TOKEN").ok();
    let telegram_chat_id = env::var("TELEGRAM_CHAT_ID").ok();
    if telegram_token.is_none() || telegram_chat_id.is_none() {
        eprintln!(
            "TELEGRAM_BOT_TOKEN and/or TELEGRAM_CHAT_ID are not set; \
             Telegram notifications are disabled for this process"
        );
    }

    let telegram_api_base =
        env::var("TELEGRAM_API_BASE").unwrap_or_else(|_| DEFAULT_TELEGRAM_API_BASE.to_string());

    let disabled = env::var("FEEDBACK_DISABLED")
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(false);

    let sink = GithubTelegramSink::new(GithubTelegramConfig {
        github_token,
        github_assets_token,
        github_api_base,
        telegram_token,
        telegram_chat_id,
        telegram_api_base,
    });

    let state = AppState::new(
        Arc::new(sink),
        RateLimiter::new(Box::new(SystemTime::now)),
        disabled,
    );

    let addr = SocketAddr::from(([0, 0, 0, 0], 8080));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .unwrap_or_else(|err| panic!("failed to bind {addr}: {err}"));

    println!("dure-feedback-intake listening on {addr}");

    axum::serve(
        listener,
        router(state).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
    .expect("feedback intake server error");
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Router;
    use axum::http::StatusCode;
    use axum::routing::get;

    /// A tiny local server answering every `/repos/...` request with a
    /// fixed `status`, standing in for GitHub's repository-metadata
    /// endpoint — in the spirit of this crate's other tests, a real local
    /// server rather than a mocked trait.
    async fn spawn_repo_status_mock(status: StatusCode) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new()
            .route("/repos/hebbianai/dure", get(move || async move { status }))
            .route(
                "/repos/hebbianai/dure-feedback-assets",
                get(move || async move { status }),
            );
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        format!("http://{addr}")
    }

    fn client_pointed_at(api_base: String) -> GithubClient {
        GithubClient::new(
            reqwest::Client::new(),
            api_base,
            "issues-token",
            "assets-token",
        )
    }

    #[tokio::test]
    async fn a_401_on_the_assets_token_exits() {
        let api_base = spawn_repo_status_mock(StatusCode::UNAUTHORIZED).await;
        let client = client_pointed_at(api_base);
        let verdict = credential_verdict(
            "GITHUB_ASSETS_TOKEN",
            client.check_assets_credential().await,
        );
        assert!(
            matches!(verdict, CredentialVerdict::Fatal(_)),
            "{verdict:?}"
        );
    }

    #[tokio::test]
    async fn a_404_on_the_issues_token_exits_and_names_that_token() {
        let api_base = spawn_repo_status_mock(StatusCode::NOT_FOUND).await;
        let client = client_pointed_at(api_base);
        let verdict = credential_verdict("GITHUB_TOKEN", client.check_issues_credential().await);
        match verdict {
            CredentialVerdict::Fatal(message) => assert!(
                message.contains("GITHUB_TOKEN"),
                "message did not name the failing token: {message}"
            ),
            other => panic!("expected a fatal verdict naming GITHUB_TOKEN, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_500_on_either_starts_anyway_with_a_warning() {
        let api_base = spawn_repo_status_mock(StatusCode::INTERNAL_SERVER_ERROR).await;
        let client = client_pointed_at(api_base);
        assert!(matches!(
            credential_verdict("GITHUB_TOKEN", client.check_issues_credential().await),
            CredentialVerdict::Warn(_)
        ));
        assert!(matches!(
            credential_verdict(
                "GITHUB_ASSETS_TOKEN",
                client.check_assets_credential().await
            ),
            CredentialVerdict::Warn(_)
        ));
    }

    #[tokio::test]
    async fn both_200s_start_silently() {
        let api_base = spawn_repo_status_mock(StatusCode::OK).await;
        let client = client_pointed_at(api_base);
        assert_eq!(
            credential_verdict("GITHUB_TOKEN", client.check_issues_credential().await),
            CredentialVerdict::Silent
        );
        assert_eq!(
            credential_verdict(
                "GITHUB_ASSETS_TOKEN",
                client.check_assets_credential().await
            ),
            CredentialVerdict::Silent
        );
    }
}
