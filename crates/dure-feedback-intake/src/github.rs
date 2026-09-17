//! Thin GitHub REST client for the feedback sink.
//!
//! It does three things: commits attachments to the asset repository via the
//! Contents API, files issues (or comments on an existing one for dedupe),
//! and lists currently-open feedback issues so the sink can search their
//! bodies for a fingerprint marker. The API base URL is a constructor
//! argument so tests can point this at a local mock server instead of
//! `https://api.github.com`; the repository names are not configuration —
//! they are the fixed product decision this sink implements.

use reqwest::{Client, StatusCode};
use serde::Deserialize;
use serde_json::json;

/// The repository committed attachments live in.
const ASSETS_REPO: &str = "hebbianai/dure-feedback-assets";

/// The repository feedback issues are filed against.
const ISSUES_REPO: &str = "hebbianai/dure-internal";

/// A failure talking to the GitHub API. Every variant is a real failure —
/// unlike Telegram, there is no best-effort path here.
#[derive(Debug)]
pub enum GithubError {
    /// The request itself could not be sent, or the response body could not
    /// be parsed as the expected JSON shape.
    Request(reqwest::Error),
    /// GitHub answered with a non-2xx status. The body is kept for logs.
    Status { status: StatusCode, body: String },
}

impl std::fmt::Display for GithubError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GithubError::Request(err) => write!(f, "github request failed: {err}"),
            GithubError::Status { status, body } => {
                write!(f, "github responded {status}: {body}")
            }
        }
    }
}

impl std::error::Error for GithubError {}

impl From<reqwest::Error> for GithubError {
    fn from(err: reqwest::Error) -> Self {
        GithubError::Request(err)
    }
}

/// The asset committed by [`GithubClient::put_asset`]. `html_url` is what the
/// issue body links to.
#[derive(Debug, Deserialize)]
pub struct CommittedAsset {
    pub html_url: String,
}

#[derive(Debug, Deserialize)]
struct ContentsResponse {
    content: CommittedAsset,
}

/// The issue created by [`GithubClient::create_issue`].
#[derive(Debug, Deserialize)]
pub struct CreatedIssue {
    pub number: u64,
    pub html_url: String,
}

/// One row of [`GithubClient::list_open_feedback_issues`]. `body` is
/// `None` when GitHub omits it (never happens in practice for issues, but
/// the API technically allows a null body), which just means it can never
/// match a fingerprint marker.
#[derive(Debug, Deserialize)]
pub struct OpenIssue {
    pub number: u64,
    pub html_url: String,
    #[serde(default)]
    pub body: Option<String>,
}

/// A GitHub REST client scoped to the two repositories this sink touches.
/// It holds two credentials rather than one: a fine-grained PAT applies one
/// permission set to every repository it selects, so a single token here
/// would mean an internet-facing service holds Contents write on
/// `ASSETS_REPO` (the code repository) merely because it also needs Issues
/// write on `ISSUES_REPO` — compromising the intake would then let someone
/// rewrite code, not just spam issues. `token` and `assets_token` are
/// scoped to exactly one repository each.
pub struct GithubClient {
    http: Client,
    api_base: String,
    /// Used for every call against [`ISSUES_REPO`]: the dedupe listing,
    /// issue creation, comment creation. Needs only Issues read/write on
    /// `dure-internal`.
    token: String,
    /// Used only for the Contents API calls against [`ASSETS_REPO`]. Needs
    /// only Contents read/write on `dure-feedback-assets` — never anything
    /// on the code repository.
    assets_token: String,
}

impl GithubClient {
    pub fn new(
        http: Client,
        api_base: impl Into<String>,
        token: impl Into<String>,
        assets_token: impl Into<String>,
    ) -> Self {
        Self {
            http,
            api_base: api_base.into(),
            token: token.into(),
            assets_token: assets_token.into(),
        }
    }

    /// Stamps the headers every GitHub REST call needs — bearer auth with
    /// the given `token`, the versioned JSON media type, and a `User-Agent`
    /// (GitHub rejects unauthenticated-looking requests without one) — for
    /// calls against `ISSUES_REPO`.
    fn authed(&self, builder: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        Self::stamp(builder, &self.token)
    }

    /// Same headers, but bearing `assets_token` — for Contents API calls
    /// against `ASSETS_REPO`. A distinct method so the two credentials can
    /// never be mixed up by an inline typo at a call site: `put_asset` is
    /// the only caller.
    fn authed_for_assets(&self, builder: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        Self::stamp(builder, &self.assets_token)
    }

    fn stamp(builder: reqwest::RequestBuilder, token: &str) -> reqwest::RequestBuilder {
        builder
            .bearer_auth(token)
            .header("accept", "application/vnd.github+json")
            .header("x-github-api-version", "2022-11-28")
            .header("user-agent", "dure-feedback-intake")
    }

    async fn error_for_status(
        response: reqwest::Response,
    ) -> Result<reqwest::Response, GithubError> {
        let status = response.status();
        if status.is_success() {
            return Ok(response);
        }
        let body = response.text().await.unwrap_or_default();
        Err(GithubError::Status { status, body })
    }

    /// Commits one attachment at `path` (relative to the assets repo root).
    /// `content_b64` is passed straight through to the Contents API, which
    /// itself expects base64 — the wire format already carries attachment
    /// bytes that way, so this never decodes and re-encodes them.
    pub async fn put_asset(
        &self,
        path: &str,
        content_b64: &str,
        message: &str,
    ) -> Result<CommittedAsset, GithubError> {
        let url = format!("{}/repos/{ASSETS_REPO}/contents/{path}", self.api_base);
        let response = self
            .authed_for_assets(self.http.put(&url))
            .json(&json!({ "message": message, "content": content_b64 }))
            .send()
            .await?;
        let response = Self::error_for_status(response).await?;
        let parsed: ContentsResponse = response.json().await?;
        Ok(parsed.content)
    }

    /// Files a new issue with the given title, body and labels.
    pub async fn create_issue(
        &self,
        title: &str,
        body: &str,
        labels: &[&str],
    ) -> Result<CreatedIssue, GithubError> {
        let url = format!("{}/repos/{ISSUES_REPO}/issues", self.api_base);
        let response = self
            .authed(self.http.post(&url))
            .json(&json!({ "title": title, "body": body, "labels": labels }))
            .send()
            .await?;
        let response = Self::error_for_status(response).await?;
        Ok(response.json().await?)
    }

    /// Lists every open issue labeled `source:feedback`, capped at the REST
    /// list endpoint's own page size of 100 — this client does not paginate
    /// past the first page. Accepted consequence: past 100 simultaneously
    /// open `source:feedback` issues, an older duplicate's fingerprint
    /// marker falls off this page and a repeat submission for it files a
    /// new issue instead of commenting on the existing one. Deliberately
    /// the REST list endpoint, not the search API: the search index lags by
    /// minutes, which is exactly the window a duplicate submission needs
    /// the dedupe rule to cover.
    pub async fn list_open_feedback_issues(&self) -> Result<Vec<OpenIssue>, GithubError> {
        let url = format!(
            "{}/repos/{ISSUES_REPO}/issues?labels=source:feedback&state=open&per_page=100",
            self.api_base
        );
        let response = self.authed(self.http.get(&url)).send().await?;
        let response = Self::error_for_status(response).await?;
        Ok(response.json().await?)
    }

    /// Comments on an existing issue instead of filing a duplicate.
    pub async fn create_comment(&self, issue_number: u64, body: &str) -> Result<(), GithubError> {
        let url = format!(
            "{}/repos/{ISSUES_REPO}/issues/{issue_number}/comments",
            self.api_base
        );
        let response = self
            .authed(self.http.post(&url))
            .json(&json!({ "body": body }))
            .send()
            .await?;
        Self::error_for_status(response).await?;
        Ok(())
    }

    /// A lightweight authenticated `GET` against a repository, used only to
    /// establish whether `token` can see it at all — not a specific
    /// permission check, just visibility, which is exactly what a
    /// missing/lapsed/wrong-scoped credential fails at. Deliberately not
    /// `error_for_status`: the caller needs to distinguish "this credential
    /// is bad" from "GitHub didn't answer", which a single `Result<_,
    /// GithubError>` collapses.
    async fn check_repository_visibility(
        http: &Client,
        api_base: &str,
        repo: &str,
        token: &str,
    ) -> CredentialCheck {
        let url = format!("{api_base}/repos/{repo}");
        let response = Self::stamp(http.get(&url), token).send().await;
        match response {
            Ok(response) if response.status().is_success() => CredentialCheck::Valid,
            Ok(response)
                if response.status() == StatusCode::UNAUTHORIZED
                    || response.status() == StatusCode::FORBIDDEN =>
            {
                CredentialCheck::Invalid
            }
            Ok(response) if response.status() == StatusCode::NOT_FOUND => {
                CredentialCheck::RepositoryNotVisible
            }
            Ok(response) => {
                CredentialCheck::Unverifiable(format!("unexpected status {}", response.status()))
            }
            Err(err) => CredentialCheck::Unverifiable(err.to_string()),
        }
    }

    /// Boot-time check: can `token` see [`ISSUES_REPO`] at all?
    pub async fn check_issues_credential(&self) -> CredentialCheck {
        Self::check_repository_visibility(&self.http, &self.api_base, ISSUES_REPO, &self.token)
            .await
    }

    /// Boot-time check: can `assets_token` see [`ASSETS_REPO`] at all?
    pub async fn check_assets_credential(&self) -> CredentialCheck {
        Self::check_repository_visibility(
            &self.http,
            &self.api_base,
            ASSETS_REPO,
            &self.assets_token,
        )
        .await
    }
}

/// Outcome of a boot-time credential validity check
/// ([`GithubClient::check_issues_credential`],
/// [`GithubClient::check_assets_credential`]). Deliberately distinguishes
/// "the credential is bad" from "GitHub didn't answer": only the former
/// should stop the process from starting — a GitHub outage must not be
/// treated the same as a bad token.
#[derive(Debug, PartialEq, Eq)]
pub enum CredentialCheck {
    /// The repository is visible to this credential.
    Valid,
    /// 401 or 403: a definitively bad, revoked, or expired credential.
    Invalid,
    /// 404: the credential cannot see this repository at all. The likely
    /// cause is a token minted against the wrong resource owner or
    /// repository selection, not a lapsed one — still definitive, so
    /// treated the same as [`Self::Invalid`] by the caller.
    RepositoryNotVisible,
    /// A timeout, a 5xx, a transport error, or any other non-definitive
    /// answer. Not evidence about the credential itself; carries a short
    /// reason for the startup log.
    Unverifiable(String),
}
