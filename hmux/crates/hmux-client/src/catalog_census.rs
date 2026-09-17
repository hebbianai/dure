//! Reclaimable isolation for bounded local discovery reads.
//!
//! Portable `std::fs` directory enumeration has no cancellation primitive. A
//! deadline checked between entries does not bound one blocked `read_dir` or
//! manifest read, while abandoning a lookup thread leaks that blocked worker.
//! Broad census and targeted lookup therefore run in a no-descendant helper
//! process. The parent accepts only one complete response sequence; at the
//! shared deadline it kills and reaps the helper and returns a typed timeout,
//! never a shorter result set.

use crate::catalog::{
    MAX_DISCOVERED_SESSIONS, resolve_session_descriptor, resolve_session_name_descriptor,
};
use crate::{
    ClientError, LocalSession, LocalSessionCatalog, SessionCatalogQuery, SessionCatalogSnapshot,
    SessionDescriptor, SessionSelector,
};
use hmux_host::local_discovery::DiscoveryError;
use hmux_runtime_contract::{read_json_frame, write_json_frame};
use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::fmt;
use std::io;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Private executable entry point used by [`CatalogCensusWorker`].
#[doc(hidden)]
pub const CATALOG_CENSUS_WORKER_SUBCOMMAND: &str = "internal-discovery-census";

const CENSUS_SCHEMA_VERSION: u8 = 5;
const MAX_CENSUS_PAGE_SESSIONS: usize = 16;
const MAX_CENSUS_BUDGET: Duration = Duration::from_secs(60);
const CHILD_POLL_INTERVAL: Duration = Duration::from_millis(5);
const WORKER_FAILED_CODE: &str = "hmux_discovery_census_worker_failed";
const WORKER_INVALID_CODE: &str = "hmux_discovery_census_worker_invalid";
const CENSUS_TIMEOUT_CODE: &str = "hmux_discovery_census_timeout";
const RESOLVED_GENERATION_CHANGED_CODE: &str = "hmux_discovery_generation_changed";

#[cfg(debug_assertions)]
const TEST_CENSUS_DELAY_ENV: &str = "HMUX_TEST_DISCOVERY_CENSUS_DELAY_MS";
#[cfg(debug_assertions)]
const TEST_CENSUS_GENERATION_PATH_ENV: &str = "HMUX_TEST_DISCOVERY_CENSUS_GENERATION_PATH";

/// One bounded request accepted by the private discovery helper.
#[doc(hidden)]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogCensusRequest {
    pub schema_version: u8,
    pub discovery_root: PathBuf,
    pub read_only_discovery_roots: Vec<PathBuf>,
    pub deadline_unix_ms: u64,
    pub operation: CatalogCensusOperation,
}

/// Exactly one read authority executed by a private census worker.
#[doc(hidden)]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CatalogCensusOperation {
    List,
    ResolveIdentifier { identifier: String },
    ExactSessionId { session_id: String },
    ExactName { name: String },
    Query { query: SessionCatalogQuery },
}

/// One bounded frame in the all-or-nothing private discovery response.
#[doc(hidden)]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case", deny_unknown_fields)]
pub enum CatalogCensusResponse {
    Page {
        schema_version: u8,
        sessions: Vec<SessionDescriptor>,
        has_more: bool,
    },
    TimedOut {
        schema_version: u8,
    },
    LookupFailed {
        schema_version: u8,
        error_code: String,
    },
    CatalogPage {
        schema_version: u8,
        sessions: Vec<SessionDescriptor>,
        has_more: bool,
        complete: bool,
        prioritized_items: usize,
        omitted_count: usize,
    },
}

enum CatalogCensusOutcome {
    Complete(Vec<SessionDescriptor>),
    Catalog(SessionCatalogSnapshot),
    TimedOut,
    LookupFailed(String),
}

/// A bounded census failed without claiming that unscanned sessions are absent.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CatalogCensusError {
    TimedOut,
    LookupFailed { error_code: String },
    WorkerFailed,
    WorkerInvalid,
}

impl CatalogCensusError {
    #[must_use]
    pub fn code(&self) -> &str {
        match self {
            Self::TimedOut => CENSUS_TIMEOUT_CODE,
            Self::LookupFailed { error_code } => error_code,
            Self::WorkerFailed => WORKER_FAILED_CODE,
            Self::WorkerInvalid => WORKER_INVALID_CODE,
        }
    }
}

impl fmt::Display for CatalogCensusError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TimedOut => write!(
                formatter,
                "local discovery read exceeded its wall-clock budget ({CENSUS_TIMEOUT_CODE})"
            ),
            Self::LookupFailed { error_code } => {
                write!(formatter, "local discovery read failed ({error_code})")
            }
            Self::WorkerFailed => write!(
                formatter,
                "local discovery worker failed ({WORKER_FAILED_CODE})"
            ),
            Self::WorkerInvalid => write!(
                formatter,
                "local discovery worker returned an invalid response ({WORKER_INVALID_CODE})"
            ),
        }
    }
}

impl std::error::Error for CatalogCensusError {}

/// One authoritative bounded discovery read could not resolve its target.
#[derive(Debug)]
pub enum CatalogResolutionError {
    Census(CatalogCensusError),
    Resolve(ClientError),
}

impl CatalogResolutionError {
    #[must_use]
    pub fn code(&self) -> &str {
        match self {
            Self::Census(error) => error.code(),
            Self::Resolve(error) => error.code(),
        }
    }

    /// True only when a complete census or exact follow-up lookup proves that
    /// the requested target is absent. A timeout is deliberately never absent.
    #[must_use]
    pub fn is_session_absent(&self) -> bool {
        matches!(self, Self::Resolve(error) if error.is_session_absent())
    }

    #[must_use]
    pub fn census_error(&self) -> Option<&CatalogCensusError> {
        match self {
            Self::Census(error) => Some(error),
            Self::Resolve(_) => None,
        }
    }
}

impl fmt::Display for CatalogResolutionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Census(error) => error.fmt(formatter),
            Self::Resolve(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for CatalogResolutionError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Census(error) => Some(error),
            Self::Resolve(error) => Some(error),
        }
    }
}

impl From<CatalogCensusError> for CatalogResolutionError {
    fn from(error: CatalogCensusError) -> Self {
        Self::Census(error)
    }
}

impl From<ClientError> for CatalogResolutionError {
    fn from(error: ClientError) -> Self {
        Self::Resolve(error)
    }
}

/// Trusted executable that serves [`CATALOG_CENSUS_WORKER_SUBCOMMAND`].
///
/// Both `hmux` and `hmux-runtime` implement the same private entry point. The
/// helper performs one tagged local discovery read, writes one bounded
/// response, and exits without descendants.
#[derive(Clone, Debug)]
pub struct CatalogCensusWorker {
    executable: PathBuf,
    arguments: Box<[OsString]>,
}

impl CatalogCensusWorker {
    #[must_use]
    pub fn new(executable: impl Into<PathBuf>) -> Self {
        Self {
            executable: executable.into(),
            arguments: vec![OsString::from(CATALOG_CENSUS_WORKER_SUBCOMMAND)].into_boxed_slice(),
        }
    }

    fn command(&self) -> Command {
        let mut command = Command::new(&self.executable);
        command.args(self.arguments.iter());
        command
    }
}

/// Serve one private, framed census request.
#[doc(hidden)]
pub fn serve_catalog_census(
    mut input: impl io::Read,
    mut output: impl io::Write,
) -> Result<(), hmux_runtime_contract::RuntimeContractError> {
    let request = read_json_frame::<CatalogCensusRequest>(&mut input)?;
    if request.schema_version != CENSUS_SCHEMA_VERSION {
        return write_json_frame(
            &mut output,
            &CatalogCensusResponse::LookupFailed {
                schema_version: CENSUS_SCHEMA_VERSION,
                error_code: WORKER_INVALID_CODE.into(),
            },
        );
    }
    if request.deadline_unix_ms <= unix_time_ms() {
        return write_json_frame(
            &mut output,
            &CatalogCensusResponse::TimedOut {
                schema_version: CENSUS_SCHEMA_VERSION,
            },
        );
    }
    apply_test_delay();
    if request.deadline_unix_ms <= unix_time_ms() {
        return write_json_frame(
            &mut output,
            &CatalogCensusResponse::TimedOut {
                schema_version: CENSUS_SCHEMA_VERSION,
            },
        );
    }
    let catalog = LocalSessionCatalog::with_read_only_discovery_roots(
        request.discovery_root,
        request.read_only_discovery_roots,
    );
    let catalog = match catalog {
        Ok(catalog) => catalog,
        Err(error) => {
            return write_json_frame(
                &mut output,
                &CatalogCensusResponse::LookupFailed {
                    schema_version: CENSUS_SCHEMA_VERSION,
                    error_code: census_error_code(&error).into(),
                },
            );
        }
    };
    let sessions = match request.operation {
        CatalogCensusOperation::Query { query } => {
            return match catalog.query(&query) {
                Ok(catalog) => write_catalog_response_pages(&mut output, catalog),
                Err(error) => write_json_frame(
                    &mut output,
                    &CatalogCensusResponse::LookupFailed {
                        schema_version: CENSUS_SCHEMA_VERSION,
                        error_code: census_error_code(&error).into(),
                    },
                ),
            };
        }
        CatalogCensusOperation::List => catalog.list(),
        CatalogCensusOperation::ResolveIdentifier { identifier } => {
            catalog.list_resolution_candidates(&identifier)
        }
        CatalogCensusOperation::ExactSessionId { session_id } => {
            catalog.list_session_id(&session_id)
        }
        CatalogCensusOperation::ExactName { name } if valid_exact_name(&name) => {
            catalog.list_named(&name)
        }
        CatalogCensusOperation::ExactName { .. } => Err(ClientError::transport(
            WORKER_INVALID_CODE,
            "exact discovery name is invalid",
        )),
    };
    let sessions = match sessions {
        Ok(sessions) => sessions,
        Err(error) => {
            return write_json_frame(
                &mut output,
                &CatalogCensusResponse::LookupFailed {
                    schema_version: CENSUS_SCHEMA_VERSION,
                    error_code: census_error_code(&error).into(),
                },
            );
        }
    };
    if sessions.is_empty() {
        return write_json_frame(
            &mut output,
            &CatalogCensusResponse::Page {
                schema_version: CENSUS_SCHEMA_VERSION,
                sessions,
                has_more: false,
            },
        );
    }
    let page_count = sessions.len().div_ceil(MAX_CENSUS_PAGE_SESSIONS);
    for (index, page) in sessions.chunks(MAX_CENSUS_PAGE_SESSIONS).enumerate() {
        write_json_frame(
            &mut output,
            &CatalogCensusResponse::Page {
                schema_version: CENSUS_SCHEMA_VERSION,
                sessions: page.to_vec(),
                has_more: index + 1 < page_count,
            },
        )?;
    }
    Ok(())
}

fn write_catalog_response_pages(
    mut output: impl io::Write,
    catalog: SessionCatalogSnapshot,
) -> Result<(), hmux_runtime_contract::RuntimeContractError> {
    if catalog.sessions.is_empty() {
        return write_json_frame(
            &mut output,
            &CatalogCensusResponse::CatalogPage {
                schema_version: CENSUS_SCHEMA_VERSION,
                sessions: Vec::new(),
                has_more: false,
                complete: catalog.complete,
                prioritized_items: catalog.prioritized_items,
                omitted_count: catalog.truncation.omitted_count,
            },
        );
    }
    let page_count = catalog.sessions.len().div_ceil(MAX_CENSUS_PAGE_SESSIONS);
    for (index, sessions) in catalog
        .sessions
        .chunks(MAX_CENSUS_PAGE_SESSIONS)
        .enumerate()
    {
        write_json_frame(
            &mut output,
            &CatalogCensusResponse::CatalogPage {
                schema_version: CENSUS_SCHEMA_VERSION,
                sessions: sessions.to_vec(),
                has_more: index + 1 < page_count,
                complete: catalog.complete,
                prioritized_items: catalog.prioritized_items,
                omitted_count: catalog.truncation.omitted_count,
            },
        )?;
    }
    Ok(())
}

/// Enumerate the local catalog inside a reclaimable helper process.
///
/// The returned vector is always a complete census. A timeout or worker fault
/// returns an error instead of a partial vector, so callers cannot interpret an
/// unvisited identity as absent. Budgets above 60 seconds are capped.
pub fn list_local_sessions_isolated(
    catalog: &LocalSessionCatalog,
    worker: &CatalogCensusWorker,
    total_budget: Duration,
) -> Result<Vec<SessionDescriptor>, CatalogCensusError> {
    read_sessions_isolated(catalog, worker, CatalogCensusOperation::List, total_budget)
}

/// Produce one bounded catalog projection in the reclaimable census worker.
/// The worker still completes the filesystem census; only retained descriptors
/// and serialized output obey the query's smaller item and byte budgets.
pub fn query_local_sessions_isolated(
    catalog: &LocalSessionCatalog,
    worker: &CatalogCensusWorker,
    query: SessionCatalogQuery,
    total_budget: Duration,
) -> Result<SessionCatalogSnapshot, CatalogCensusError> {
    let budget = total_budget.min(MAX_CENSUS_BUDGET);
    if budget.is_zero() {
        return Err(CatalogCensusError::TimedOut);
    }
    let deadline = Instant::now()
        .checked_add(budget)
        .ok_or(CatalogCensusError::TimedOut)?;
    let request = CatalogCensusRequest {
        schema_version: CENSUS_SCHEMA_VERSION,
        discovery_root: catalog.discovery_root().to_path_buf(),
        read_only_discovery_roots: catalog.read_only_discovery_roots().to_vec(),
        deadline_unix_ms: worker_deadline_unix_ms(deadline),
        operation: CatalogCensusOperation::Query { query },
    };
    let outcome = run_census_process(worker, request, deadline)?;
    if Instant::now() >= deadline {
        return Err(CatalogCensusError::TimedOut);
    }
    match outcome {
        CatalogCensusOutcome::Catalog(catalog) => Ok(catalog),
        CatalogCensusOutcome::Complete(_) => Err(CatalogCensusError::WorkerInvalid),
        CatalogCensusOutcome::TimedOut => Err(CatalogCensusError::TimedOut),
        CatalogCensusOutcome::LookupFailed(error_code) => {
            Err(CatalogCensusError::LookupFailed { error_code })
        }
    }
}

/// Resolve a human-facing name, exact id, or unique id prefix in one
/// reclaimable worker.
///
/// A valid exact id uses the targeted workspace-level path lookup first. Only
/// proven absence falls through to the complete name/prefix census. The chosen
/// read is all-or-error within `total_budget`; after selection, the parent
/// reopens only that exact workspace/session path and rejects a replacement
/// Host generation rather than attaching to it.
pub fn resolve_local_session_isolated(
    catalog: &LocalSessionCatalog,
    worker: &CatalogCensusWorker,
    identifier: &str,
    total_budget: Duration,
) -> Result<LocalSession, CatalogResolutionError> {
    let sessions = read_sessions_isolated(
        catalog,
        worker,
        CatalogCensusOperation::ResolveIdentifier {
            identifier: identifier.to_string(),
        },
        total_budget,
    )?;
    resolve_local_session_from_authoritative_candidates(catalog, &sessions, identifier)
        .map_err(CatalogResolutionError::from)
}

/// Resolve one exact opaque session id without a name/prefix fallback.
pub fn resolve_local_session_id_isolated(
    catalog: &LocalSessionCatalog,
    worker: &CatalogCensusWorker,
    session_id: &str,
    total_budget: Duration,
) -> Result<LocalSession, CatalogResolutionError> {
    let sessions = read_sessions_isolated(
        catalog,
        worker,
        CatalogCensusOperation::ExactSessionId {
            session_id: session_id.to_string(),
        },
        total_budget,
    )?;
    resolve_local_session_from_authoritative_candidates(catalog, &sessions, session_id)
        .map_err(CatalogResolutionError::from)
}

/// Resolve an explicit human-facing name on one complete, reclaimable census.
/// Session ids and prefixes are never considered by this entry point.
pub fn resolve_local_session_name_isolated(
    catalog: &LocalSessionCatalog,
    worker: &CatalogCensusWorker,
    name: &str,
    total_budget: Duration,
) -> Result<LocalSession, CatalogResolutionError> {
    let sessions = list_local_sessions_named_isolated(catalog, worker, name, total_budget)?;
    resolve_local_session_name_from_complete_census(catalog, &sessions, name)
        .map_err(CatalogResolutionError::from)
}

fn list_local_sessions_named_isolated(
    catalog: &LocalSessionCatalog,
    worker: &CatalogCensusWorker,
    name: &str,
    total_budget: Duration,
) -> Result<Vec<SessionDescriptor>, CatalogCensusError> {
    if !valid_exact_name(name) {
        return Err(CatalogCensusError::WorkerInvalid);
    }
    read_sessions_isolated(
        catalog,
        worker,
        CatalogCensusOperation::ExactName {
            name: name.to_string(),
        },
        total_budget,
    )
}

fn read_sessions_isolated(
    catalog: &LocalSessionCatalog,
    worker: &CatalogCensusWorker,
    operation: CatalogCensusOperation,
    total_budget: Duration,
) -> Result<Vec<SessionDescriptor>, CatalogCensusError> {
    let budget = total_budget.min(MAX_CENSUS_BUDGET);
    if budget.is_zero() {
        return Err(CatalogCensusError::TimedOut);
    }
    let deadline = Instant::now()
        .checked_add(budget)
        .ok_or(CatalogCensusError::TimedOut)?;
    let request = CatalogCensusRequest {
        schema_version: CENSUS_SCHEMA_VERSION,
        discovery_root: catalog.discovery_root().to_path_buf(),
        read_only_discovery_roots: catalog.read_only_discovery_roots().to_vec(),
        deadline_unix_ms: worker_deadline_unix_ms(deadline),
        operation,
    };
    let outcome = run_census_process(worker, request, deadline)?;
    if Instant::now() >= deadline {
        return Err(CatalogCensusError::TimedOut);
    }
    match outcome {
        CatalogCensusOutcome::Complete(sessions) => Ok(sessions),
        CatalogCensusOutcome::Catalog(_) => Err(CatalogCensusError::WorkerInvalid),
        CatalogCensusOutcome::TimedOut => Err(CatalogCensusError::TimedOut),
        CatalogCensusOutcome::LookupFailed(error_code) => {
            Err(CatalogCensusError::LookupFailed { error_code })
        }
    }
}

fn valid_exact_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 256 && !name.chars().any(char::is_control)
}

/// Resolve against a caller-owned complete census without enumerating again.
pub fn resolve_local_session_from_complete_census(
    catalog: &LocalSessionCatalog,
    sessions: &[SessionDescriptor],
    identifier: &str,
) -> Result<LocalSession, ClientError> {
    resolve_local_session_from_authoritative_candidates(catalog, sessions, identifier)
}

fn resolve_local_session_from_authoritative_candidates(
    catalog: &LocalSessionCatalog,
    sessions: &[SessionDescriptor],
    identifier: &str,
) -> Result<LocalSession, ClientError> {
    let selected = resolve_session_descriptor(sessions, identifier)?;
    open_selected_exact(catalog, selected)
}

/// Resolve an exact name against a caller-owned complete census without
/// enumerating again.
pub fn resolve_local_session_name_from_complete_census(
    catalog: &LocalSessionCatalog,
    sessions: &[SessionDescriptor],
    name: &str,
) -> Result<LocalSession, ClientError> {
    let selected = resolve_session_name_descriptor(sessions, name)?;
    open_selected_exact(catalog, selected)
}

fn open_selected_exact(
    catalog: &LocalSessionCatalog,
    selected: SessionDescriptor,
) -> Result<LocalSession, ClientError> {
    let session = catalog.open(&SessionSelector::new(
        selected.session_id.clone(),
        Some(selected.workspace_id.clone()),
    ))?;
    if !session.descriptor().same_generation(&selected) {
        return Err(ClientError::Transport {
            code: RESOLVED_GENERATION_CHANGED_CODE,
            message: format!(
                "Hmux session {:?} changed generation after catalog resolution; retry",
                selected.session_id
            ),
        });
    }
    Ok(session)
}

fn census_error_code(error: &ClientError) -> &str {
    match error {
        ClientError::Discovery(DiscoveryError::LookupLimitExceeded { .. }) => {
            "hmux_discovery_result_limit"
        }
        ClientError::Discovery(DiscoveryError::LookupScanLimitExceeded { .. }) => {
            "hmux_discovery_scan_limit"
        }
        ClientError::Discovery(DiscoveryError::Security { .. }) => "hmux_discovery_security",
        other => other.code(),
    }
}

fn run_census_process(
    worker: &CatalogCensusWorker,
    request: CatalogCensusRequest,
    deadline: Instant,
) -> Result<CatalogCensusOutcome, CatalogCensusError> {
    let mut child = worker
        .command()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| CatalogCensusError::WorkerFailed)?;
    let Some(input) = child.stdin.take() else {
        terminate_child(&mut child);
        return Err(CatalogCensusError::WorkerFailed);
    };
    let Some(output) = child.stdout.take() else {
        terminate_child(&mut child);
        return Err(CatalogCensusError::WorkerFailed);
    };
    let writer = match std::thread::Builder::new()
        .name("hmux-discovery-census-request".into())
        .spawn(move || {
            let mut input = input;
            write_json_frame(&mut input, &request)
        }) {
        Ok(writer) => writer,
        Err(_) => {
            terminate_child(&mut child);
            return Err(CatalogCensusError::WorkerFailed);
        }
    };
    let reader = match std::thread::Builder::new()
        .name("hmux-discovery-census-response".into())
        .spawn(move || read_census_response_sequence(output))
    {
        Ok(reader) => reader,
        Err(_) => {
            terminate_child(&mut child);
            let _ = join_writer(writer);
            return Err(CatalogCensusError::WorkerFailed);
        }
    };

    loop {
        if reader.is_finished() {
            let response = join_reader(reader);
            terminate_child(&mut child);
            let wrote = join_writer(writer);
            return match (wrote, response) {
                (true, Ok(response)) => Ok(response),
                (true, Err(error)) => Err(error),
                _ => Err(CatalogCensusError::WorkerFailed),
            };
        }
        match child.try_wait() {
            Ok(Some(status)) if status.success() => {
                let wrote = join_writer(writer);
                let response = join_reader(reader);
                return match (wrote, response) {
                    (true, Ok(response)) => Ok(response),
                    (true, Err(error)) => Err(error),
                    _ => Err(CatalogCensusError::WorkerFailed),
                };
            }
            Ok(Some(_)) | Err(_) => {
                terminate_child(&mut child);
                let _ = join_writer(writer);
                let _ = join_reader(reader);
                return Err(CatalogCensusError::WorkerFailed);
            }
            Ok(None) => {}
        }
        if Instant::now() >= deadline {
            terminate_child(&mut child);
            let _ = join_writer(writer);
            let _ = join_reader(reader);
            return Err(CatalogCensusError::TimedOut);
        }
        std::thread::sleep(CHILD_POLL_INTERVAL);
    }
}

fn worker_deadline_unix_ms(deadline: Instant) -> u64 {
    let remaining = deadline.saturating_duration_since(Instant::now());
    unix_time_ms().saturating_add(u64::try_from(remaining.as_millis()).unwrap_or(u64::MAX))
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

fn terminate_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn join_writer(
    writer: JoinHandle<Result<(), hmux_runtime_contract::RuntimeContractError>>,
) -> bool {
    writer.join().is_ok_and(|result| result.is_ok())
}

fn join_reader(
    reader: JoinHandle<Result<CatalogCensusOutcome, CatalogCensusError>>,
) -> Result<CatalogCensusOutcome, CatalogCensusError> {
    reader
        .join()
        .map_err(|_| CatalogCensusError::WorkerFailed)?
}

fn read_census_response_sequence(
    mut input: impl io::Read,
) -> Result<CatalogCensusOutcome, CatalogCensusError> {
    let mut sessions = Vec::new();
    let mut catalog_metadata = None;
    loop {
        let response = read_json_frame::<CatalogCensusResponse>(&mut input)
            .map_err(|_| CatalogCensusError::WorkerFailed)?;
        match response {
            CatalogCensusResponse::Page {
                schema_version: CENSUS_SCHEMA_VERSION,
                sessions: page,
                has_more,
            } if page.len() <= MAX_CENSUS_PAGE_SESSIONS
                && (!has_more || !page.is_empty())
                && sessions.len().saturating_add(page.len()) <= MAX_DISCOVERED_SESSIONS =>
            {
                sessions.extend(page);
                if !has_more {
                    return Ok(CatalogCensusOutcome::Complete(sessions));
                }
            }
            CatalogCensusResponse::TimedOut {
                schema_version: CENSUS_SCHEMA_VERSION,
            } if sessions.is_empty() => return Ok(CatalogCensusOutcome::TimedOut),
            CatalogCensusResponse::LookupFailed {
                schema_version: CENSUS_SCHEMA_VERSION,
                error_code,
            } if sessions.is_empty() && !error_code.is_empty() => {
                return Ok(CatalogCensusOutcome::LookupFailed(error_code));
            }
            CatalogCensusResponse::CatalogPage {
                schema_version: CENSUS_SCHEMA_VERSION,
                sessions: page,
                has_more,
                complete,
                prioritized_items,
                omitted_count,
            } if page.len() <= MAX_CENSUS_PAGE_SESSIONS
                && (!has_more || !page.is_empty())
                && sessions.len().saturating_add(page.len()) <= MAX_DISCOVERED_SESSIONS
                && catalog_metadata.is_none_or(|metadata| {
                    metadata == (complete, prioritized_items, omitted_count)
                }) =>
            {
                catalog_metadata = Some((complete, prioritized_items, omitted_count));
                sessions.extend(page);
                if !has_more {
                    if prioritized_items > sessions.len() || !complete {
                        return Err(CatalogCensusError::WorkerInvalid);
                    }
                    return Ok(CatalogCensusOutcome::Catalog(SessionCatalogSnapshot {
                        schema_version: crate::SESSION_CATALOG_QUERY_SCHEMA_VERSION,
                        complete,
                        prioritized_items,
                        truncation: crate::SessionCatalogTruncation {
                            items: omitted_count > 0,
                            omitted_count,
                        },
                        sessions,
                    }));
                }
            }
            _ => return Err(CatalogCensusError::WorkerInvalid),
        }
    }
}

#[cfg(debug_assertions)]
fn apply_test_delay() {
    if let Some(path) =
        std::env::var_os(TEST_CENSUS_GENERATION_PATH_ENV).filter(|value| !value.is_empty())
    {
        publish_test_process_generation(PathBuf::from(path));
    }
    let delay_ms = std::env::var(TEST_CENSUS_DELAY_ENV)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0)
        .min(60_000);
    std::thread::sleep(Duration::from_millis(delay_ms));
}

#[cfg(all(debug_assertions, unix))]
fn publish_test_process_generation(path: PathBuf) {
    let Ok(generation) = crate::exact_local_process_generation(std::process::id()) else {
        return;
    };
    let Ok(document) = serde_json::to_vec(&generation) else {
        return;
    };
    let _ = std::fs::write(path, document);
}

#[cfg(all(debug_assertions, not(unix)))]
fn publish_test_process_generation(path: PathBuf) {
    let _ = std::fs::write(path, std::process::id().to_string());
}

#[cfg(not(debug_assertions))]
fn apply_test_delay() {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        EndpointDescriptor, EndpointKind, ProcessDescriptor, ProtocolVersion, SessionClass,
        SessionLifecycle, VersionRange,
    };
    use std::io::Cursor;
    use tempfile::TempDir;

    fn ready_descriptor(index: usize) -> SessionDescriptor {
        SessionDescriptor {
            schema_version: 1,
            session_id: format!("session-{index:03}"),
            session_name: None,
            workspace_id: "workspace-1".into(),
            session_class: SessionClass::Standalone,
            lifecycle: SessionLifecycle::Ready,
            provider_id: "fixture".into(),
            runtime_host: None,
            worktree_alias: None,
            branch: None,
            launch_program: None,
            runner_principal: "runner".into(),
            runner_instance: "runner-1".into(),
            channel_epoch: "1".into(),
            host_instance_id: format!("host-{index:03}"),
            terminal_epoch: format!("terminal-{index:03}"),
            output_seq: "0".into(),
            host_build_version: "test".into(),
            supported_protocol: VersionRange {
                minimum: ProtocolVersion { major: 1, minor: 0 },
                maximum: ProtocolVersion { major: 1, minor: 0 },
            },
            capabilities: vec![],
            retirement_policy: None,
            host_process: ProcessDescriptor {
                process_id: 1,
                start_marker: "host".into(),
            },
            provider_process: ProcessDescriptor {
                process_id: 1,
                start_marker: "provider".into(),
            },
            endpoint: EndpointDescriptor {
                kind: EndpointKind::UnixSocket,
                address: "/unreachable/session.sock".into(),
            },
            created_unix_ms: "1".into(),
            lifecycle_changed_unix_ms: "2".into(),
            exit: None,
            failure: None,
        }
    }

    #[test]
    fn expired_worker_request_never_reads_the_discovery_root() {
        let fixture = TempDir::new().unwrap();
        let invalid_root = fixture.path().join("not-a-directory");
        std::fs::write(&invalid_root, b"not discovery").unwrap();
        let request = CatalogCensusRequest {
            schema_version: CENSUS_SCHEMA_VERSION,
            discovery_root: invalid_root,
            read_only_discovery_roots: Vec::new(),
            deadline_unix_ms: 0,
            operation: CatalogCensusOperation::List,
        };
        let mut input = Vec::new();
        write_json_frame(&mut input, &request).unwrap();
        let mut output = Vec::new();

        serve_catalog_census(Cursor::new(input), &mut output).unwrap();

        assert!(matches!(
            read_json_frame::<CatalogCensusResponse>(&mut Cursor::new(output)).unwrap(),
            CatalogCensusResponse::TimedOut {
                schema_version: CENSUS_SCHEMA_VERSION
            }
        ));
    }

    #[test]
    fn worker_request_encodes_exactly_one_tagged_read_operation() {
        let operation = serde_json::to_value(CatalogCensusOperation::ExactSessionId {
            session_id: "session-1".into(),
        })
        .unwrap();
        assert_eq!(
            operation,
            serde_json::json!({
                "kind": "exact_session_id",
                "sessionId": "session-1",
            })
        );
        assert!(
            serde_json::from_value::<CatalogCensusOperation>(serde_json::json!({
                "kind": "exact_session_id",
                "sessionId": "session-1",
                "name": "other-authority",
            }))
            .is_err()
        );
    }

    #[test]
    fn bounded_response_pages_reassemble_one_complete_inventory() {
        let descriptors = (0..=MAX_CENSUS_PAGE_SESSIONS)
            .map(ready_descriptor)
            .collect::<Vec<_>>();
        let mut framed = Vec::new();
        for (index, page) in descriptors.chunks(MAX_CENSUS_PAGE_SESSIONS).enumerate() {
            write_json_frame(
                &mut framed,
                &CatalogCensusResponse::Page {
                    schema_version: CENSUS_SCHEMA_VERSION,
                    sessions: page.to_vec(),
                    has_more: index == 0,
                },
            )
            .unwrap();
        }

        let CatalogCensusOutcome::Complete(reassembled) =
            read_census_response_sequence(Cursor::new(framed)).unwrap()
        else {
            panic!("expected a complete response sequence");
        };
        assert_eq!(reassembled, descriptors);
    }

    #[test]
    fn a_non_page_after_partial_output_invalidates_the_inventory() {
        let mut framed = Vec::new();
        write_json_frame(
            &mut framed,
            &CatalogCensusResponse::Page {
                schema_version: CENSUS_SCHEMA_VERSION,
                sessions: vec![ready_descriptor(0)],
                has_more: true,
            },
        )
        .unwrap();
        write_json_frame(
            &mut framed,
            &CatalogCensusResponse::LookupFailed {
                schema_version: CENSUS_SCHEMA_VERSION,
                error_code: "unexpected".into(),
            },
        )
        .unwrap();

        assert!(matches!(
            read_census_response_sequence(Cursor::new(framed)),
            Err(CatalogCensusError::WorkerInvalid)
        ));
    }

    #[test]
    fn scan_and_result_limits_keep_distinct_stable_codes() {
        assert_eq!(
            census_error_code(&ClientError::Discovery(
                DiscoveryError::LookupScanLimitExceeded { maximum: 7 }
            )),
            "hmux_discovery_scan_limit"
        );
        assert_eq!(
            census_error_code(&ClientError::Discovery(
                DiscoveryError::LookupLimitExceeded { maximum: 7 }
            )),
            "hmux_discovery_result_limit"
        );
    }

    #[test]
    fn zero_budget_is_a_typed_timeout_without_spawning() {
        let catalog = LocalSessionCatalog::new("/unused");
        let worker = CatalogCensusWorker::new("/also-unused");

        assert_eq!(
            list_local_sessions_isolated(&catalog, &worker, Duration::ZERO),
            Err(CatalogCensusError::TimedOut)
        );
    }

    #[test]
    fn census_timeout_is_never_classified_as_session_absence() {
        let timeout = CatalogResolutionError::Census(CatalogCensusError::TimedOut);
        assert_eq!(timeout.code(), "hmux_discovery_census_timeout");
        assert!(!timeout.is_session_absent());

        let absent = CatalogResolutionError::Resolve(ClientError::SessionNotFound {
            session_id: "missing".into(),
            workspace_id: None,
        });
        assert_eq!(absent.code(), "hmux_session_not_found");
        assert!(absent.is_session_absent());
    }
}
