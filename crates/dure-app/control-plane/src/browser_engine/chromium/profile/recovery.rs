//! Non-destructive recovery never reads Chromium's SingletonLock as authority.
//! Unknown old claims acquire a reboot witness; they cannot be inferred safe
//! from a missing PID, an empty Browser list or an absent lock symlink.
use super::*;
use evidence::{Launch, NativeClaim, Restart, unconfirmed};
use hmux_client::{
    LocalProcessGenerationStatus, local_boot_identity, probe_local_process_generation,
};
use serde::Serialize;
use sha2::{Digest, Sha256};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RecoveryState {
    Available,
    Live,
    Recoverable,
    RestartRequired,
    Unconfirmed,
}

struct Recovery {
    file: File,
    path: PathBuf,
    digest: String,
    state: RecoveryState,
    boot: String,
}

impl Recovery {
    fn inspect(
        directory: &Path,
        id: &BrowserProfileIdV1,
    ) -> Result<Option<Self>, BrowserEngineError> {
        let root = storage_root(directory, id)?;
        let path = root.join("native-claim.json");
        let Some(file) = evidence::open(&path)? else {
            return Ok(None);
        };
        evidence::lock(&file)?;
        evidence::same_file(&file, &path)?;
        let bytes = evidence::bytes(&file)?;
        let claim: NativeClaim = serde_json::from_slice(&bytes).map_err(unconfirmed)?;
        if claim.profile_id != *id
            || !matches!(claim.schema_version, 1 | 2)
            || (claim.schema_version == 1 && (claim.owner.is_some() || claim.boot.is_some()))
            || (claim.schema_version == 2 && (claim.owner.is_none() || claim.boot.is_none()))
        {
            return Err(unconfirmed("unsupported native claim"));
        }
        if claim.boot.as_deref().is_some_and(|boot| !valid_boot(boot)) {
            return Err(unconfirmed("invalid claim boot identity"));
        }
        let boot = local_boot_identity().map_err(unconfirmed)?;
        let digest = format!("{:x}", Sha256::digest(&bytes));
        let state = if let Some(old_boot) = &claim.boot {
            if old_boot != &boot {
                RecoveryState::Recoverable
            } else {
                current_boot_state(&root, &claim)?
            }
        } else {
            RecoveryState::RestartRequired
        };
        let restart: Option<Restart> = evidence::read(&root.join(evidence::RESTART))?;
        if restart
            .as_ref()
            .is_some_and(|witness| !valid_boot(&witness.boot))
        {
            return Err(unconfirmed("invalid recovery boot identity"));
        }
        let state = if state == RecoveryState::RestartRequired
            && restart.is_some_and(|w| w.claim_digest == digest && w.boot != boot)
        {
            RecoveryState::Recoverable
        } else {
            state
        };
        Ok(Some(Self {
            file,
            path,
            digest,
            state,
            boot,
        }))
    }

    fn recover(self) -> Result<(), BrowserEngineError> {
        let root = self.path.parent().expect("claim parent");
        match self.state {
            RecoveryState::Available | RecoveryState::Recoverable => {
                evidence::same_file(&self.file, &self.path)?;
                evidence::clear_records(root)?;
                // Keep the claim pathname occupied until every proof check and
                // companion-record update finished. Acquire uses create_new.
                evidence::same_file(&self.file, &self.path)?;
                fs::remove_file(&self.path).map_err(unconfirmed)?;
                File::open(root)
                    .and_then(|file| file.sync_all())
                    .map_err(unconfirmed)
            }
            RecoveryState::RestartRequired => {
                evidence::publish(
                    &root.join(evidence::RESTART),
                    &Restart {
                        claim_digest: self.digest,
                        boot: self.boot,
                    },
                )?;
                Err(BrowserEngineError::before(
                    "browser_profile_recovery_restart_required",
                ))
            }
            RecoveryState::Live => Err(BrowserEngineError::before("browser_profile_owner_live")),
            RecoveryState::Unconfirmed => Err(unconfirmed("writer state unknown")),
        }
    }
}

fn current_boot_state(
    root: &Path,
    claim: &NativeClaim,
) -> Result<RecoveryState, BrowserEngineError> {
    let launch: Option<Launch> = evidence::read(&root.join(evidence::LAUNCH))?;
    match launch {
        Some(launch) if launch.instance_id != claim.instance_id => {
            Err(unconfirmed("launch changed"))
        }
        Some(Launch {
            process: Some(process),
            ..
        }) => {
            if hmux_client::local_process_session_is_stably_empty(&process).map_err(unconfirmed)? {
                Ok(RecoveryState::Recoverable)
            } else {
                Ok(RecoveryState::Live)
            }
        }
        // The intent was durable before spawning. The backend may have died
        // between spawn and process-witness publication: require a reboot.
        Some(Launch { process: None, .. }) => Ok(RecoveryState::RestartRequired),
        None => {
            match probe_local_process_generation(claim.owner.as_ref().expect("validated owner"))
                .map_err(unconfirmed)?
            {
                LocalProcessGenerationStatus::Absent => Ok(RecoveryState::Recoverable),
                LocalProcessGenerationStatus::Live => Ok(RecoveryState::Live),
            }
        }
    }
}

pub(crate) fn recovery_status(directory: &Path, id: &BrowserProfileIdV1) -> RecoveryState {
    match Recovery::inspect(directory, id) {
        Ok(None) => RecoveryState::Available,
        Ok(Some(recovery)) => recovery.state,
        Err(error) if error.code == "browser_profile_recovery_in_progress" => RecoveryState::Live,
        Err(_) => RecoveryState::Unconfirmed,
    }
}

pub(crate) fn recover_storage(
    directory: &Path,
    id: &BrowserProfileIdV1,
) -> Result<(), BrowserEngineError> {
    match Recovery::inspect(directory, id)? {
        None => Ok(()),
        Some(recovery) => recovery.recover(),
    }
}

fn valid_boot(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, byte)| {
            if [8, 13, 18, 23].contains(&i) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
            }
        })
}

#[cfg(test)]
mod tests;
