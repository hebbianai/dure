//! Reclaimable isolation for exact local discovery probes.
//!
//! `std::fs` has no portable cancellation primitive. A deadline can let a
//! caller stop waiting for a lookup thread, but it cannot reclaim that thread.
//! This module instead sends each probe to a no-descendant helper process and
//! keeps the process-wide scheduler, queue, and child count bounded.

use crate::control_plane::{
    SESSION_PROBE_QUANTUM, inspection_from_probe, validate_exact_probe_targets,
};
use crate::{
    ExactSessionProbeBatchError, ExactSessionProbeResult, LocalSessionCatalog, SessionDescriptor,
    SessionLifecycle, SessionProbeStatus, SessionSelector, inspect_local_sessions_exact,
};
use hmux_runtime_contract::{read_json_frame, write_json_frame};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock, mpsc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Private CLI entry point used by [`ExactDiscoveryWorker`].
#[doc(hidden)]
pub const EXACT_DISCOVERY_WORKER_SUBCOMMAND: &str = "internal-exact-discovery-lookup";

const MAX_PROCESS_WIDE_LOOKUPS: usize = 8;
const MAX_PENDING_LOOKUPS: usize = 128;
const MAX_ISOLATED_BATCH_BUDGET: Duration = Duration::from_secs(60);
const CHILD_POLL_INTERVAL: Duration = Duration::from_millis(5);
const WORKER_FAILURE_CODE: &str = "hmux_discovery_worker_failed";
const WORKER_INVALID_CODE: &str = "hmux_discovery_worker_invalid";
const EXACT_SCHEMA_VERSION: u8 = 2;
const EXACT_BATCH_SCHEMA_VERSION: u8 = 3;

/// Latched when a spawned worker rejects a batch frame (an older installed
/// runtime). Every later slice downgrades to single lookups for this process
/// lifetime; the next app start retries batch against the then-current
/// worker.
static BATCH_LOOKUP_UNSUPPORTED: AtomicBool = AtomicBool::new(false);

/// Bounded request accepted by the private exact-discovery helper.
#[doc(hidden)]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExactDiscoveryLookupRequest {
    pub schema_version: u8,
    pub selector: SessionSelector,
    pub read_only_discovery_roots: Vec<PathBuf>,
    pub deadline_unix_ms: u64,
}

/// Bounded response returned by the private exact-discovery helper.
#[doc(hidden)]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case", deny_unknown_fields)]
pub enum ExactDiscoveryLookupResponse {
    Found {
        schema_version: u8,
        descriptor: Box<SessionDescriptor>,
        probe_status: Option<SessionProbeStatus>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent_runtime_state: Option<crate::AgentRuntimeStateDescriptor>,
    },
    NotFound {
        schema_version: u8,
    },
    LookupFailed {
        schema_version: u8,
        error_code: String,
    },
    Unprobed {
        schema_version: u8,
    },
}

/// Bounded batch request accepted by the private exact-discovery helper.
///
/// One helper process serves every selector in the batch sequentially. This
/// exists because process spawn dominated exact discovery: every selector
/// cost one helper process (~27MB binary page-in), and a ~45-target
/// observation pass every few seconds summed to ~876MB of disk I/O per wave
/// on the 2026-08-24 live daily driver (~600GB/day in Activity Monitor).
#[doc(hidden)]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExactDiscoveryBatchLookupRequest {
    pub schema_version: u8,
    pub selectors: Vec<SessionSelector>,
    pub read_only_discovery_roots: Vec<PathBuf>,
    pub deadline_unix_ms: u64,
}

/// Bounded batch response: one entry per requested selector, in order.
#[doc(hidden)]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExactDiscoveryBatchLookupResponse {
    pub schema_version: u8,
    pub results: Vec<ExactDiscoveryLookupResponse>,
}

/// Both request generations accepted on the worker's framed stdin. Batch is
/// tried first (its required `selectors` field cannot match the single
/// shape); a v2-only worker rejects the batch frame at parse time, which the
/// client detects as process failure and downgrades to single lookups.
#[derive(Deserialize)]
#[serde(untagged)]
enum AnyExactDiscoveryLookupRequest {
    Batch(ExactDiscoveryBatchLookupRequest),
    Single(ExactDiscoveryLookupRequest),
}

/// Serve one private exact-discovery lookup request on bounded framed stdio.
#[doc(hidden)]
pub fn serve_exact_discovery_lookup(
    catalog: &LocalSessionCatalog,
    mut input: impl io::Read,
    mut output: impl io::Write,
) -> Result<(), hmux_runtime_contract::RuntimeContractError> {
    let request = match read_json_frame::<AnyExactDiscoveryLookupRequest>(&mut input)? {
        AnyExactDiscoveryLookupRequest::Batch(batch) => {
            let response = serve_batch_request(catalog, batch);
            return write_json_frame(&mut output, &response);
        }
        AnyExactDiscoveryLookupRequest::Single(request) => request,
    };
    let lookup_catalog = LocalSessionCatalog::with_read_only_discovery_roots(
        catalog.discovery_root().to_path_buf(),
        request.read_only_discovery_roots,
    );
    let request_is_invalid = request.schema_version != EXACT_SCHEMA_VERSION
        || validate_exact_probe_targets(std::slice::from_ref(&request.selector)).is_err();
    let response = match (request_is_invalid, lookup_catalog) {
        (true, _) | (_, Err(_)) => ExactDiscoveryLookupResponse::LookupFailed {
            schema_version: EXACT_SCHEMA_VERSION,
            error_code: WORKER_INVALID_CODE.into(),
        },
        (false, Ok(lookup_catalog)) => {
            let budget = request
                .deadline_unix_ms
                .saturating_sub(unix_time_ms())
                .min(MAX_ISOLATED_BATCH_BUDGET.as_millis() as u64);
            match inspect_local_sessions_exact(
                &lookup_catalog,
                vec![request.selector],
                1,
                Duration::from_millis(budget),
            ) {
                Ok(mut results) => match results.pop() {
                    None => ExactDiscoveryLookupResponse::LookupFailed {
                        schema_version: EXACT_SCHEMA_VERSION,
                        error_code: WORKER_INVALID_CODE.into(),
                    },
                    Some(result) => probe_result_to_response(result),
                },
                Err(_) => ExactDiscoveryLookupResponse::LookupFailed {
                    schema_version: EXACT_SCHEMA_VERSION,
                    error_code: WORKER_INVALID_CODE.into(),
                },
            }
        }
    };
    write_json_frame(&mut output, &response)
}

fn probe_result_to_response(result: ExactSessionProbeResult) -> ExactDiscoveryLookupResponse {
    match result {
        ExactSessionProbeResult::Inspection(inspection) => {
            let probe_status = inspection.probe_status();
            ExactDiscoveryLookupResponse::Found {
                schema_version: EXACT_SCHEMA_VERSION,
                probe_status,
                agent_runtime_state: inspection.agent_runtime_state,
                descriptor: Box::new(inspection.descriptor),
            }
        }
        ExactSessionProbeResult::NotFound(_) => ExactDiscoveryLookupResponse::NotFound {
            schema_version: EXACT_SCHEMA_VERSION,
        },
        ExactSessionProbeResult::LookupFailed { error_code, .. } => {
            ExactDiscoveryLookupResponse::LookupFailed {
                schema_version: EXACT_SCHEMA_VERSION,
                error_code,
            }
        }
        ExactSessionProbeResult::Unprobed(_) => ExactDiscoveryLookupResponse::Unprobed {
            schema_version: EXACT_SCHEMA_VERSION,
        },
    }
}

fn serve_batch_request(
    catalog: &LocalSessionCatalog,
    request: ExactDiscoveryBatchLookupRequest,
) -> ExactDiscoveryBatchLookupResponse {
    let selector_count = request.selectors.len();
    let invalid = |count: usize| ExactDiscoveryBatchLookupResponse {
        schema_version: EXACT_BATCH_SCHEMA_VERSION,
        results: (0..count)
            .map(|_| ExactDiscoveryLookupResponse::LookupFailed {
                schema_version: EXACT_SCHEMA_VERSION,
                error_code: WORKER_INVALID_CODE.into(),
            })
            .collect(),
    };
    if request.schema_version != EXACT_BATCH_SCHEMA_VERSION
        || validate_exact_probe_targets(&request.selectors).is_err()
    {
        return invalid(selector_count);
    }
    let Ok(lookup_catalog) = LocalSessionCatalog::with_read_only_discovery_roots(
        catalog.discovery_root().to_path_buf(),
        request.read_only_discovery_roots,
    ) else {
        return invalid(selector_count);
    };
    let budget = request
        .deadline_unix_ms
        .saturating_sub(unix_time_ms())
        .min(MAX_ISOLATED_BATCH_BUDGET.as_millis() as u64);
    match inspect_local_sessions_exact(
        &lookup_catalog,
        request.selectors,
        1,
        Duration::from_millis(budget),
    ) {
        Ok(results) if results.len() == selector_count => ExactDiscoveryBatchLookupResponse {
            schema_version: EXACT_BATCH_SCHEMA_VERSION,
            results: results.into_iter().map(probe_result_to_response).collect(),
        },
        _ => invalid(selector_count),
    }
}

/// Trusted executable that implements [`EXACT_DISCOVERY_WORKER_SUBCOMMAND`].
///
/// The helper must serve exactly one framed request — a single exact catalog
/// lookup or one bounded batch of them — write one framed response, and exit
/// without spawning descendants. `hmux` itself implements this contract. Long-running consumers
/// should keep one value and use
/// [`inspect_local_sessions_exact_isolated`] so stalled filesystem operations
/// remain process-reclaimable.
#[derive(Clone, Debug)]
pub struct ExactDiscoveryWorker {
    executable: PathBuf,
    arguments: Arc<[OsString]>,
}

impl ExactDiscoveryWorker {
    #[must_use]
    pub fn new(executable: impl Into<PathBuf>) -> Self {
        Self {
            executable: executable.into(),
            arguments: Arc::from([OsString::from(EXACT_DISCOVERY_WORKER_SUBCOMMAND)]),
        }
    }

    fn command(&self, discovery_root: &Path) -> Command {
        let mut command = Command::new(&self.executable);
        command
            .arg("--discovery-root")
            .arg(discovery_root)
            .args(self.arguments.iter());
        command
    }
}

/// Probe exact targets while isolating every potentially stalled filesystem
/// lookup in a reclaimable helper process.
///
/// Across overlapping calls in one consumer process, at most eight probes run
/// and at most 128 more wait in the FIFO scheduler. A caller budget is capped
/// at 60 seconds; work that cannot enter the scheduler or finish before that
/// deadline stays `Unprobed`.
pub fn inspect_local_sessions_exact_isolated(
    catalog: &LocalSessionCatalog,
    worker: &ExactDiscoveryWorker,
    selectors: Vec<SessionSelector>,
    maximum_workers: usize,
    total_budget: Duration,
) -> Result<Vec<ExactSessionProbeResult>, ExactSessionProbeBatchError> {
    validate_exact_probe_targets(&selectors)?;
    if selectors.is_empty() {
        return Ok(Vec::new());
    }

    let workers = maximum_workers
        .clamp(1, MAX_PROCESS_WIDE_LOOKUPS)
        .min(selectors.len());
    let mut results = selectors
        .iter()
        .cloned()
        .map(ExactSessionProbeResult::Unprobed)
        .collect::<Vec<_>>();
    let started = Instant::now();
    let Some(deadline) = started.checked_add(total_budget.min(MAX_ISOLATED_BATCH_BUDGET)) else {
        return Ok(results);
    };
    let deadline = Some(deadline);
    if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
        return Ok(results);
    }

    let discovery_root = catalog.discovery_root().to_path_buf();
    let read_only_discovery_roots = Arc::new(catalog.read_only_discovery_roots().to_vec());
    let selectors = Arc::new(selectors);
    let (sender, receiver) = mpsc::channel();
    // One worker process per contiguous slice instead of one per selector:
    // spawn count per pass drops from selector count (~45 observed live) to
    // the worker bound. A slice worker that predates the batch schema fails
    // the frame parse, latches the downgrade, and the slice retries as
    // single lookups.
    let chunk = selectors.len().div_ceil(workers);
    let mut expected = 0usize;
    let mut start = 0usize;
    while start < selectors.len() {
        let end = start.saturating_add(chunk).min(selectors.len());
        if submit_slice_lookup(
            start..end,
            Arc::clone(&selectors),
            discovery_root.clone(),
            Arc::clone(&read_only_discovery_roots),
            worker.clone(),
            deadline,
            sender.clone(),
        ) {
            expected += end - start;
        }
        start = end;
    }

    let mut received = 0usize;
    while received < expected {
        let message = match deadline {
            Some(deadline) => {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    break;
                }
                match receiver.recv_timeout(remaining) {
                    Ok(message) => message,
                    Err(mpsc::RecvTimeoutError::Timeout | mpsc::RecvTimeoutError::Disconnected) => {
                        break;
                    }
                }
            }
            None => match receiver.recv() {
                Ok(message) => message,
                Err(_) => break,
            },
        };
        received += 1;
        results[message.index] = message.result;
    }
    Ok(results)
}

struct ExactLookupMessage {
    index: usize,
    result: ExactSessionProbeResult,
}

fn submit_slice_lookup(
    range: std::ops::Range<usize>,
    selectors: Arc<Vec<SessionSelector>>,
    discovery_root: PathBuf,
    read_only_discovery_roots: Arc<Vec<PathBuf>>,
    worker: ExactDiscoveryWorker,
    deadline: Option<Instant>,
    sender: mpsc::Sender<ExactLookupMessage>,
) -> bool {
    exact_lookup_executor().submit_until(
        Box::new(move || {
            let slice = &selectors[range.clone()];
            let send_unprobed_from = |offset: usize| {
                for (extra, selector) in slice.iter().enumerate().skip(offset) {
                    let _ = sender.send(ExactLookupMessage {
                        index: range.start + extra,
                        result: ExactSessionProbeResult::Unprobed(selector.clone()),
                    });
                }
            };
            if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                send_unprobed_from(0);
                return;
            }
            if slice.len() > 1 && !BATCH_LOOKUP_UNSUPPORTED.load(Ordering::Relaxed) {
                match run_batch_lookup_process(
                    &discovery_root,
                    read_only_discovery_roots.as_ref(),
                    &worker,
                    slice,
                    deadline,
                ) {
                    Ok(responses) => {
                        for (offset, response) in responses.into_iter().enumerate() {
                            let _ = sender.send(ExactLookupMessage {
                                index: range.start + offset,
                                result: finalize_lookup(slice[offset].clone(), response, deadline),
                            });
                        }
                        return;
                    }
                    Err(LookupProcessError::Deadline) => {
                        send_unprobed_from(0);
                        return;
                    }
                    // An older installed worker rejects the batch frame at
                    // parse time and exits without a response — downgrade
                    // this slice (and this process lifetime) to singles.
                    Err(LookupProcessError::Failed) => {
                        BATCH_LOOKUP_UNSUPPORTED.store(true, Ordering::Relaxed);
                    }
                }
            }
            for (offset, selector) in slice.iter().enumerate() {
                if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                    send_unprobed_from(offset);
                    return;
                }
                let _ = sender.send(ExactLookupMessage {
                    index: range.start + offset,
                    result: execute_lookup(
                        &discovery_root,
                        read_only_discovery_roots.as_ref(),
                        &worker,
                        selector.clone(),
                        deadline,
                    ),
                });
            }
        }),
        deadline,
    )
}

fn run_batch_lookup_process(
    discovery_root: &Path,
    read_only_discovery_roots: &[PathBuf],
    worker: &ExactDiscoveryWorker,
    selectors: &[SessionSelector],
    deadline: Option<Instant>,
) -> Result<Vec<ExactDiscoveryLookupResponse>, LookupProcessError> {
    let request = ExactDiscoveryBatchLookupRequest {
        schema_version: EXACT_BATCH_SCHEMA_VERSION,
        selectors: selectors.to_vec(),
        read_only_discovery_roots: read_only_discovery_roots.to_vec(),
        deadline_unix_ms: worker_deadline_unix_ms(deadline),
    };
    let response: ExactDiscoveryBatchLookupResponse =
        run_worker_process(discovery_root, worker, request, deadline)?;
    if response.schema_version != EXACT_BATCH_SCHEMA_VERSION
        || response.results.len() != selectors.len()
    {
        return Err(LookupProcessError::Failed);
    }
    Ok(response.results)
}

fn execute_lookup(
    discovery_root: &Path,
    read_only_discovery_roots: &[PathBuf],
    worker: &ExactDiscoveryWorker,
    selector: SessionSelector,
    deadline: Option<Instant>,
) -> ExactSessionProbeResult {
    let response = match run_lookup_process(
        discovery_root,
        read_only_discovery_roots,
        worker,
        &selector,
        deadline,
    ) {
        Ok(response) => response,
        Err(LookupProcessError::Deadline) => {
            return ExactSessionProbeResult::Unprobed(selector);
        }
        Err(LookupProcessError::Failed) => {
            return lookup_failed(selector, WORKER_FAILURE_CODE);
        }
    };
    finalize_lookup(selector, response, deadline)
}

fn finalize_lookup(
    selector: SessionSelector,
    response: ExactDiscoveryLookupResponse,
    deadline: Option<Instant>,
) -> ExactSessionProbeResult {
    match response {
        ExactDiscoveryLookupResponse::Found {
            schema_version: EXACT_SCHEMA_VERSION,
            descriptor,
            mut probe_status,
            mut agent_runtime_state,
        } if descriptor.session_id == selector.session_id
            && selector.workspace_id.as_deref() == Some(descriptor.workspace_id.as_str()) =>
        {
            if descriptor.lifecycle == SessionLifecycle::Exited {
                return ExactSessionProbeResult::Inspection(Box::new(inspection_from_probe(
                    *descriptor,
                    Some(SessionProbeStatus::Exited),
                )));
            }
            if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                probe_status = None;
                agent_runtime_state = None;
            }
            let mut inspection = inspection_from_probe(*descriptor, probe_status);
            if probe_status == Some(SessionProbeStatus::Healthy) {
                inspection.agent_runtime_state = agent_runtime_state;
            }
            ExactSessionProbeResult::Inspection(Box::new(inspection))
        }
        ExactDiscoveryLookupResponse::NotFound {
            schema_version: EXACT_SCHEMA_VERSION,
        } => ExactSessionProbeResult::NotFound(selector),
        ExactDiscoveryLookupResponse::LookupFailed {
            schema_version: EXACT_SCHEMA_VERSION,
            error_code,
        } => lookup_failed(selector, lookup_error_code(&error_code)),
        ExactDiscoveryLookupResponse::Unprobed {
            schema_version: EXACT_SCHEMA_VERSION,
        } => ExactSessionProbeResult::Unprobed(selector),
        _ => lookup_failed(selector, WORKER_INVALID_CODE),
    }
}

fn lookup_failed(selector: SessionSelector, error_code: &'static str) -> ExactSessionProbeResult {
    ExactSessionProbeResult::LookupFailed {
        selector,
        error_code: error_code.into(),
    }
}

fn lookup_error_code(code: &str) -> &'static str {
    match code {
        "hmux_discovery_failed" => "hmux_discovery_failed",
        "hmux_io_failed" => "hmux_io_failed",
        "hmux_discovery_root_invalid" => "hmux_discovery_root_invalid",
        "hmux_discovery_root_limit" => "hmux_discovery_root_limit",
        "hmux_discovery_generation_ambiguous" => "hmux_discovery_generation_ambiguous",
        "hmux_session_ambiguous" => "hmux_session_ambiguous",
        _ => WORKER_INVALID_CODE,
    }
}

enum LookupProcessError {
    Deadline,
    Failed,
}

fn run_lookup_process(
    discovery_root: &Path,
    read_only_discovery_roots: &[PathBuf],
    worker: &ExactDiscoveryWorker,
    selector: &SessionSelector,
    deadline: Option<Instant>,
) -> Result<ExactDiscoveryLookupResponse, LookupProcessError> {
    let request = ExactDiscoveryLookupRequest {
        schema_version: EXACT_SCHEMA_VERSION,
        selector: selector.clone(),
        read_only_discovery_roots: read_only_discovery_roots.to_vec(),
        deadline_unix_ms: worker_deadline_unix_ms(deadline),
    };
    run_worker_process(discovery_root, worker, request, deadline)
}

/// Spawn one helper process, write one framed request, read one framed
/// response. Shared by the single (v2) and batch (v3) request generations.
fn run_worker_process<Request, Response>(
    discovery_root: &Path,
    worker: &ExactDiscoveryWorker,
    request: Request,
    deadline: Option<Instant>,
) -> Result<Response, LookupProcessError>
where
    Request: Serialize + Send + 'static,
    Response: serde::de::DeserializeOwned + Send + 'static,
{
    let mut child = worker
        .command(discovery_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| LookupProcessError::Failed)?;
    let Some(input) = child.stdin.take() else {
        terminate_child(&mut child);
        return Err(LookupProcessError::Failed);
    };
    let Some(output) = child.stdout.take() else {
        terminate_child(&mut child);
        return Err(LookupProcessError::Failed);
    };
    let writer = match std::thread::Builder::new()
        .name("hmux-exact-discovery-request".into())
        .spawn(move || {
            let mut input = input;
            write_json_frame(&mut input, &request)
        }) {
        Ok(writer) => writer,
        Err(_) => {
            terminate_child(&mut child);
            return Err(LookupProcessError::Failed);
        }
    };
    let reader = match std::thread::Builder::new()
        .name("hmux-exact-discovery-response".into())
        .spawn(move || {
            let mut output = output;
            read_json_frame::<Response>(&mut output)
        }) {
        Ok(reader) => reader,
        Err(_) => {
            terminate_child(&mut child);
            let _ = join_writer(writer);
            return Err(LookupProcessError::Failed);
        }
    };

    loop {
        if reader.is_finished() {
            let response = join_reader(reader);
            terminate_child(&mut child);
            let wrote = join_writer(writer);
            return match (wrote, response) {
                (true, Some(response)) => Ok(response),
                _ => Err(LookupProcessError::Failed),
            };
        }
        match child.try_wait() {
            Ok(Some(status)) if status.success() => {
                let wrote = join_writer(writer);
                let response = join_reader(reader);
                return match (wrote, response) {
                    (true, Some(response)) => Ok(response),
                    _ => Err(LookupProcessError::Failed),
                };
            }
            Ok(Some(_)) | Err(_) => {
                terminate_child(&mut child);
                let _ = join_writer(writer);
                let _ = join_reader(reader);
                return Err(LookupProcessError::Failed);
            }
            Ok(None) => {}
        }
        if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
            terminate_child(&mut child);
            let _ = join_writer(writer);
            let _ = join_reader(reader);
            return Err(LookupProcessError::Deadline);
        }
        std::thread::sleep(CHILD_POLL_INTERVAL);
    }
}

fn worker_deadline_unix_ms(deadline: Option<Instant>) -> u64 {
    let remaining = deadline
        .map(|deadline| deadline.saturating_duration_since(Instant::now()))
        .unwrap_or(SESSION_PROBE_QUANTUM);
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

fn join_reader<Response>(
    reader: JoinHandle<Result<Response, hmux_runtime_contract::RuntimeContractError>>,
) -> Option<Response> {
    reader.join().ok().and_then(Result::ok)
}

type ExactLookupTask = Box<dyn FnOnce() + Send + 'static>;

struct ExactLookupExecutor {
    shared: Arc<ExactLookupQueue>,
    workers: usize,
}

struct ExactLookupQueue {
    state: Mutex<VecDeque<ExactLookupTask>>,
    available: Condvar,
    capacity: Condvar,
}

impl ExactLookupExecutor {
    fn new() -> Self {
        let shared = Arc::new(ExactLookupQueue {
            state: Mutex::new(VecDeque::new()),
            available: Condvar::new(),
            capacity: Condvar::new(),
        });
        let mut workers = 0;
        for index in 0..MAX_PROCESS_WIDE_LOOKUPS {
            let worker_queue = Arc::clone(&shared);
            if std::thread::Builder::new()
                .name(format!("hmux-exact-discovery-{index}"))
                .spawn(move || worker_loop(&worker_queue))
                .is_err()
            {
                break;
            }
            workers += 1;
        }
        Self { shared, workers }
    }

    fn submit_until(&self, task: ExactLookupTask, deadline: Option<Instant>) -> bool {
        if self.workers == 0 {
            return false;
        }
        let mut task = Some(task);
        let mut queue = lock_queue(&self.shared.state);
        loop {
            if queue.len() < MAX_PENDING_LOOKUPS {
                queue.push_back(task.take().expect("lookup task is enqueued once"));
                self.shared.available.notify_one();
                return true;
            }
            queue = match deadline {
                Some(deadline) => {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        return false;
                    }
                    let (queue, timeout) = self
                        .shared
                        .capacity
                        .wait_timeout(queue, remaining)
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    if timeout.timed_out() && queue.len() >= MAX_PENDING_LOOKUPS {
                        return false;
                    }
                    queue
                }
                None => self
                    .shared
                    .capacity
                    .wait(queue)
                    .unwrap_or_else(|poisoned| poisoned.into_inner()),
            };
        }
    }
}

fn exact_lookup_executor() -> &'static ExactLookupExecutor {
    static EXECUTOR: OnceLock<ExactLookupExecutor> = OnceLock::new();
    EXECUTOR.get_or_init(ExactLookupExecutor::new)
}

fn worker_loop(shared: &ExactLookupQueue) {
    loop {
        let task = {
            let mut queue = lock_queue(&shared.state);
            while queue.is_empty() {
                queue = shared
                    .available
                    .wait(queue)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
            }
            let task = queue.pop_front().expect("non-empty lookup queue");
            shared.capacity.notify_all();
            task
        };
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(task));
    }
}

fn lock_queue(
    queue: &Mutex<VecDeque<ExactLookupTask>>,
) -> std::sync::MutexGuard<'_, VecDeque<ExactLookupTask>> {
    queue
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        EndpointDescriptor, EndpointKind, ProcessDescriptor, ProtocolVersion, SessionClass,
        VersionRange,
    };
    use std::io::Cursor;
    use tempfile::TempDir;

    fn ready_descriptor() -> SessionDescriptor {
        SessionDescriptor {
            schema_version: 1,
            session_id: "session-1".into(),
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
            host_instance_id: "host-1".into(),
            terminal_epoch: "terminal-1".into(),
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
                address: "/unreachable/session-1.sock".into(),
            },
            created_unix_ms: "1".into(),
            lifecycle_changed_unix_ms: "2".into(),
            exit: None,
            failure: None,
        }
    }

    #[test]
    fn a_descriptor_returned_after_the_deadline_stays_unprobed() {
        let selector = SessionSelector::new("session-1", Some("workspace-1".into()));
        let result = finalize_lookup(
            selector,
            ExactDiscoveryLookupResponse::Found {
                schema_version: EXACT_SCHEMA_VERSION,
                descriptor: Box::new(ready_descriptor()),
                probe_status: Some(SessionProbeStatus::Healthy),
                agent_runtime_state: None,
            },
            Some(Instant::now()),
        );

        let ExactSessionProbeResult::Inspection(inspection) = result else {
            panic!("a resolved descriptor should retain its generation")
        };
        assert_eq!(inspection.health, crate::SessionHealth::Unprobed);
    }

    #[test]
    fn isolated_lookup_preserves_the_agent_runtime_projection() {
        let selector = SessionSelector::new("session-1", Some("workspace-1".into()));
        let mut observed =
            inspection_from_probe(ready_descriptor(), Some(SessionProbeStatus::Healthy));
        observed.agent_runtime_state = Some(crate::AgentRuntimeStateDescriptor {
            terminal_epoch: "terminal-1".into(),
            revision: "3".into(),
            observed_through_output_seq: "8".into(),
            lifecycle: crate::AgentRuntimeLifecycle::Running,
            activity: crate::AgentRuntimeActivity::Waiting,
            attention: crate::AgentRuntimeAttention::None,
            attention_id: None,
            source: crate::AgentRuntimeStateSource::ProviderEvent,
            turn_completed_count: "1".into(),
        });

        let result = finalize_lookup(
            selector,
            probe_result_to_response(ExactSessionProbeResult::Inspection(Box::new(observed))),
            None,
        );

        let ExactSessionProbeResult::Inspection(inspection) = result else {
            panic!("a healthy isolated lookup must remain an inspection")
        };
        assert_eq!(
            inspection
                .agent_runtime_state
                .as_ref()
                .map(|state| (&state.activity, state.turn_completed_count.as_str())),
            Some((&crate::AgentRuntimeActivity::Waiting, "1")),
        );
    }

    #[test]
    fn a_batch_request_returns_one_framed_response_per_selector() {
        // Process spawn dominated exact discovery: every selector cost one
        // helper process (~27MB binary page-in), and a ~45-target observation
        // pass every few seconds summed to ~876MB of disk I/O per wave on the
        // 2026-08-24 live daily driver (~600GB/day in Activity Monitor). One
        // worker process must serve a bounded batch of selectors.
        let fixture = TempDir::new().unwrap();
        let request = serde_json::json!({
            "schemaVersion": 3,
            "selectors": [
                {"sessionId": "session-1", "workspaceId": "workspace-1"},
                {"sessionId": "session-2", "workspaceId": "workspace-1"},
            ],
            "readOnlyDiscoveryRoots": [],
            "deadlineUnixMs": unix_time_ms() + 1_000,
        });
        let mut input = Vec::new();
        write_json_frame(&mut input, &request).unwrap();
        let mut output = Vec::new();

        serve_exact_discovery_lookup(
            &LocalSessionCatalog::new(fixture.path().join("canonical-missing")),
            Cursor::new(input),
            &mut output,
        )
        .unwrap();

        let response = read_json_frame::<serde_json::Value>(&mut Cursor::new(output)).unwrap();
        assert_eq!(
            response
                .get("results")
                .and_then(|results| results.as_array())
                .map(Vec::len),
            Some(2),
            "a batch request must yield one response per selector: {response}"
        );
    }

    #[test]
    fn an_expired_worker_request_does_not_touch_discovery() {
        let fixture = TempDir::new().unwrap();
        let invalid_root = fixture.path().join("regular-file-not-a-root");
        std::fs::write(&invalid_root, b"not a discovery directory").unwrap();
        let request = ExactDiscoveryLookupRequest {
            schema_version: EXACT_SCHEMA_VERSION,
            selector: SessionSelector::new("session-1", Some("workspace-1".into())),
            read_only_discovery_roots: Vec::new(),
            deadline_unix_ms: 0,
        };
        let mut input = Vec::new();
        write_json_frame(&mut input, &request).unwrap();
        let mut output = Vec::new();

        serve_exact_discovery_lookup(
            &LocalSessionCatalog::new(invalid_root),
            Cursor::new(input),
            &mut output,
        )
        .unwrap();

        let response =
            read_json_frame::<ExactDiscoveryLookupResponse>(&mut Cursor::new(output)).unwrap();
        assert!(matches!(
            response,
            ExactDiscoveryLookupResponse::Unprobed {
                schema_version: EXACT_SCHEMA_VERSION
            }
        ));
    }

    #[test]
    fn worker_exact_lookup_applies_the_bounded_read_only_roots_from_its_request() {
        let fixture = TempDir::new().unwrap();
        let invalid_legacy_root = fixture.path().join("legacy-regular-file");
        std::fs::write(&invalid_legacy_root, b"not a discovery directory").unwrap();
        let request = ExactDiscoveryLookupRequest {
            schema_version: EXACT_SCHEMA_VERSION,
            selector: SessionSelector::new("session-1", Some("workspace-1".into())),
            read_only_discovery_roots: vec![invalid_legacy_root],
            deadline_unix_ms: unix_time_ms() + 1_000,
        };
        let mut input = Vec::new();
        write_json_frame(&mut input, &request).unwrap();
        let mut output = Vec::new();

        serve_exact_discovery_lookup(
            &LocalSessionCatalog::new(fixture.path().join("canonical-missing")),
            Cursor::new(input),
            &mut output,
        )
        .unwrap();

        assert!(matches!(
            read_json_frame::<ExactDiscoveryLookupResponse>(&mut Cursor::new(output)).unwrap(),
            ExactDiscoveryLookupResponse::LookupFailed {
                schema_version: EXACT_SCHEMA_VERSION,
                ref error_code,
            } if error_code == "hmux_discovery_failed"
        ));
    }
}
