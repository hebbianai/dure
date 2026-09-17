use super::{
    BoundedTransport, MAX_ROOT_BYTES, MAX_ROOT_ROTATIONS, MAX_SNAPSHOT_BYTES, MAX_TARGETS_BYTES,
    MAX_TIMESTAMP_BYTES, ObservedMetadata, PreviousMetadata, TransportAudit, metadata_version,
    sha256_file, with_trailing_slash,
};
use std::error::Error;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tempfile::TempDir;
use tough::{
    ExpirationEnforcement, HttpTransport, Limits, Prefix, Repository, RepositoryLoader, TargetName,
};
use url::Url;

type BoxError = Box<dyn Error + Send + Sync>;

#[derive(Debug)]
enum Command {
    Init { trusted_root: PathBuf },
    Refresh,
    Download,
}

#[derive(Debug)]
struct Arguments {
    metadata_dir: PathBuf,
    metadata_url: Option<Url>,
    target_name: Option<String>,
    target_base_url: Option<Url>,
    target_dir: Option<PathBuf>,
    command: Command,
}

/// Run the exact CLI protocol used by the pinned upstream TUF conformance
/// suite. This adapter exercises `tough`; it is not linked into production.
pub async fn run_conformance_client() -> Result<(), BoxError> {
    let arguments = parse_arguments(std::env::args_os().skip(1))?;
    match arguments.command {
        Command::Init { trusted_root } => initialize(&arguments.metadata_dir, &trusted_root).await,
        Command::Refresh => {
            let metadata_url = arguments
                .metadata_url
                .ok_or("refresh requires --metadata-url")?;
            let _ = refresh_repository(&arguments.metadata_dir, metadata_url.clone(), metadata_url)
                .await?;
            Ok(())
        }
        Command::Download => download(arguments).await,
    }
}

fn parse_arguments(arguments: impl Iterator<Item = OsString>) -> Result<Arguments, BoxError> {
    let mut arguments = arguments.peekable();
    let mut metadata_dir = None;
    let mut metadata_url = None;
    let mut target_name = None;
    let mut target_base_url = None;
    let mut target_dir = None;
    let mut command = None;

    while let Some(argument) = arguments.next() {
        match argument.to_str() {
            Some("--metadata-dir") => metadata_dir = Some(PathBuf::from(next(&mut arguments)?)),
            Some("--metadata-url") => {
                metadata_url = Some(Url::parse(&next(&mut arguments)?.to_string_lossy())?)
            }
            Some("--target-name") => {
                target_name =
                    Some(next(&mut arguments)?.into_string().map_err(
                        |_| "target name must be valid UTF-8 for the TUF JSON wire format",
                    )?)
            }
            Some("--target-base-url") => {
                target_base_url = Some(Url::parse(&next(&mut arguments)?.to_string_lossy())?)
            }
            Some("--target-dir") => target_dir = Some(PathBuf::from(next(&mut arguments)?)),
            Some("init") => {
                command = Some(Command::Init {
                    trusted_root: PathBuf::from(next(&mut arguments)?),
                })
            }
            Some("refresh") => command = Some(Command::Refresh),
            Some("download") => command = Some(Command::Download),
            _ => return Err("unsupported TUF conformance client argument".into()),
        }
    }

    Ok(Arguments {
        metadata_dir: metadata_dir.ok_or("--metadata-dir is required")?,
        metadata_url,
        target_name,
        target_base_url,
        target_dir,
        command: command.ok_or("init, refresh, or download is required")?,
    })
}

fn next(arguments: &mut impl Iterator<Item = OsString>) -> Result<OsString, BoxError> {
    arguments
        .next()
        .ok_or_else(|| "missing command-line value".into())
}

async fn initialize(metadata_dir: &Path, trusted_root: &Path) -> Result<(), BoxError> {
    tokio::fs::create_dir_all(metadata_dir).await?;
    tokio::fs::create_dir_all(metadata_dir.join(".tough-state")).await?;
    let root = tokio::fs::read(trusted_root).await?;
    tokio::fs::write(metadata_dir.join("root.json"), root).await?;
    Ok(())
}

async fn refresh_repository(
    metadata_dir: &Path,
    metadata_url: Url,
    targets_url: Url,
) -> Result<Repository, BoxError> {
    let metadata_url = with_trailing_slash(metadata_url);
    let targets_url = with_trailing_slash(targets_url);
    let trusted_root = tokio::fs::read(metadata_dir.join("root.json")).await?;
    let datastore = metadata_dir.join(".tough-state");
    tokio::fs::create_dir_all(&datastore).await?;

    let observed = Arc::new(Mutex::new(ObservedMetadata::default()));
    let absolute_limit_exceeded = Arc::new(AtomicBool::new(false));
    let transport = BoundedTransport::new(
        HttpTransport::default(),
        metadata_url.clone(),
        targets_url.clone(),
        PreviousMetadata {
            timestamp: read_optional(metadata_dir.join("timestamp.json")).await?,
            snapshot: read_optional(metadata_dir.join("snapshot.json")).await?,
            targets: read_optional(metadata_dir.join("targets.json")).await?,
        },
        TransportAudit {
            observed_metadata: Arc::clone(&observed),
            absolute_limit_exceeded: Arc::clone(&absolute_limit_exceeded),
        },
    );
    let result = RepositoryLoader::new(&trusted_root, metadata_url, targets_url)
        .transport(transport)
        .limits(Limits {
            max_root_size: MAX_ROOT_BYTES,
            max_targets_size: MAX_TARGETS_BYTES,
            max_timestamp_size: MAX_TIMESTAMP_BYTES,
            max_snapshot_size: MAX_SNAPSHOT_BYTES,
            max_root_updates: MAX_ROOT_ROTATIONS + 1,
        })
        .datastore(&datastore)
        .expiration_enforcement(ExpirationEnforcement::Safe)
        .load()
        .await;

    export_trusted_metadata(metadata_dir, &datastore, &observed, result.is_ok()).await?;
    if absolute_limit_exceeded.load(Ordering::Acquire) {
        return Err("repository response exceeded the conformance adapter bound".into());
    }
    let repository = result?;
    if repository.targets().signed.delegations.is_some() {
        return Err("delegated targets are outside the Hmux TUF profile".into());
    }
    Ok(repository)
}

async fn read_optional(path: PathBuf) -> Result<Option<Vec<u8>>, std::io::Error> {
    match tokio::fs::read(path).await {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

async fn export_trusted_metadata(
    metadata_dir: &Path,
    datastore: &Path,
    observed: &Arc<Mutex<ObservedMetadata>>,
    success: bool,
) -> Result<(), BoxError> {
    if success {
        let (root, timestamp, snapshot, targets) = {
            let observed = observed
                .lock()
                .map_err(|_| "metadata capture lock was poisoned")?;
            (
                observed.roots.values().next_back().cloned(),
                observed.timestamp.clone(),
                observed.snapshot.clone(),
                observed.targets.clone(),
            )
        };
        if let Some(root) = root {
            tokio::fs::write(metadata_dir.join("root.json"), root).await?;
        }
        for (name, bytes) in [
            ("timestamp.json", timestamp),
            ("snapshot.json", snapshot),
            ("targets.json", targets),
        ] {
            if let Some(bytes) = bytes {
                tokio::fs::write(metadata_dir.join(name), bytes).await?;
            }
        }
        return Ok(());
    }

    for name in [
        "root.json",
        "timestamp.json",
        "snapshot.json",
        "targets.json",
    ] {
        let Some(candidate) = read_optional(datastore.join(name)).await? else {
            continue;
        };
        let current = read_optional(metadata_dir.join(name)).await?;
        let candidate_version = metadata_version(&candidate);
        let current_version = current.as_deref().and_then(metadata_version);
        if current_version.is_none() || candidate_version > current_version {
            tokio::fs::write(metadata_dir.join(name), candidate).await?;
        }
    }
    Ok(())
}

async fn download(arguments: Arguments) -> Result<(), BoxError> {
    let metadata_url = arguments
        .metadata_url
        .ok_or("download requires --metadata-url")?;
    let targets_url = arguments
        .target_base_url
        .ok_or("download requires --target-base-url")?;
    let target_dir = arguments
        .target_dir
        .ok_or("download requires --target-dir")?;
    let target_name = TargetName::new(
        arguments
            .target_name
            .as_deref()
            .ok_or("download requires --target-name")?,
    )?;
    let repository = refresh_repository(&arguments.metadata_dir, metadata_url, targets_url).await?;
    let target = repository
        .targets()
        .signed
        .targets
        .get(&target_name)
        .ok_or("target is absent from trusted metadata")?;
    let destination = target_dir.join(target_name.resolved());
    if tokio::fs::metadata(&destination)
        .await
        .is_ok_and(|metadata| metadata.len() == target.length)
        && sha256_file(&destination).await? == hex::encode(target.hashes.sha256.as_ref())
    {
        return Ok(());
    }

    tokio::fs::create_dir_all(&target_dir).await?;
    let staging = TempDir::new_in(&target_dir)?;
    repository
        .save_target(&target_name, staging.path(), Prefix::None)
        .await?;
    let verified = staging.path().join(target_name.resolved());
    if let Some(parent) = destination.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::rename(verified, destination).await?;
    Ok(())
}
