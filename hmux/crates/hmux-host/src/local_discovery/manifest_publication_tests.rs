use super::*;

#[test]
fn current_manifest_open_retries_one_atomic_replacement() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("manifest.json");
    let mut attempts = 0;

    let opened = retry_current_manifest_open(|| {
        attempts += 1;
        if attempts == 1 {
            Err(DiscoveryError::security(
                &path,
                SecurityViolation::ReplacedDuringOpen,
            ))
        } else {
            Ok("coherent manifest")
        }
    })
    .unwrap();

    assert_eq!(opened, "coherent manifest");
    assert_eq!(attempts, 2);
}

#[cfg(windows)]
#[test]
fn current_manifest_open_retries_replacefile_sharing_window() {
    use windows_sys::Win32::Foundation::ERROR_SHARING_VIOLATION;

    let temp = TempDir::new().unwrap();
    let path = temp.path().join("manifest.json");
    let mut attempts = 0;

    let opened = retry_current_manifest_open(|| {
        attempts += 1;
        if attempts == 1 {
            Err(DiscoveryError::io(
                "open private file",
                &path,
                std::io::Error::from_raw_os_error(i32::try_from(ERROR_SHARING_VIOLATION).unwrap()),
            ))
        } else {
            Ok("coherent manifest")
        }
    })
    .unwrap();

    assert_eq!(opened, "coherent manifest");
    assert_eq!(attempts, 2);
}

#[test]
fn current_manifest_open_replacement_retry_stays_bounded() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("manifest.json");
    let mut attempts = 0;

    let error = retry_current_manifest_open::<()>(|| {
        attempts += 1;
        Err(DiscoveryError::security(
            &path,
            SecurityViolation::ReplacedDuringOpen,
        ))
    })
    .unwrap_err();

    assert_eq!(attempts, MAX_CURRENT_MANIFEST_OPEN_ATTEMPTS);
    assert!(matches!(
        error,
        DiscoveryError::Security {
            violation: SecurityViolation::ReplacedDuringOpen,
            ..
        }
    ));
}

#[test]
fn current_manifest_open_does_not_retry_other_security_failures() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("manifest.json");
    let mut attempts = 0;

    let error = retry_current_manifest_open::<()>(|| {
        attempts += 1;
        Err(DiscoveryError::security(&path, SecurityViolation::Symlink))
    })
    .unwrap_err();

    assert_eq!(attempts, 1);
    assert!(matches!(
        error,
        DiscoveryError::Security {
            violation: SecurityViolation::Symlink,
            ..
        }
    ));
}

#[cfg(windows)]
#[test]
fn current_manifest_reads_converge_during_native_publication() {
    use std::sync::Barrier;
    use std::thread;

    const READERS: usize = 2;
    const ROUNDS: usize = 64;
    const READS_PER_ROUND: usize = 32;

    let temp = TempDir::new().unwrap();
    let discovery = session(&temp);
    let lock = discovery.acquire_lifetime_lock().unwrap();
    discovery
        .publish_starting(&lock, standalone_starting("host-1"))
        .unwrap();
    discovery
        .publish_ready(&lock, standalone_ready("host-1"))
        .unwrap();
    let generation = discovery.read_manifest().unwrap().generation();
    let barrier = Barrier::new(READERS + 1);

    thread::scope(|scope| {
        let observer = &discovery;
        let rendezvous = &barrier;
        let readers = (0..READERS)
            .map(|_| {
                scope.spawn(move || {
                    let mut successful_reads = 0;
                    let mut first_error = None;
                    for round in 0..ROUNDS {
                        rendezvous.wait();
                        for _ in 0..READS_PER_ROUND {
                            match observer.read_manifest() {
                                Ok(DiscoveryManifest::Ready(ready))
                                    if ready.common.host_instance_id == "host-1"
                                        && ready.terminal_epoch == "terminal-1" =>
                                {
                                    successful_reads += 1;
                                }
                                Ok(_) => {
                                    first_error.get_or_insert_with(|| {
                                        format!("round {round}: changed lifecycle or generation")
                                    });
                                }
                                Err(error) => {
                                    first_error
                                        .get_or_insert_with(|| format!("round {round}: {error}"));
                                }
                            }
                        }
                        rendezvous.wait();
                    }
                    (successful_reads, first_error)
                })
            })
            .collect::<Vec<_>>();

        // Overlap real publication with reads, retaining the first failure even
        // when a later open succeeds. Complete every round before asserting so
        // an ordinary I/O error cannot strand a reader at the rendezvous.
        let mut publication_error = None;
        for round in 0..ROUNDS {
            barrier.wait();
            let policy = SessionRetirementPolicy::AfterGracefulLastClientDepartureV1 {
                grace_period_ms: SessionRetirementPolicy::MIN_GRACE_PERIOD_MS
                    + u64::try_from(round).unwrap(),
            };
            if let Err(error) =
                discovery.update_ready_retirement_policy(&lock, &generation, Some(policy))
            {
                publication_error.get_or_insert_with(|| format!("round {round}: {error}"));
            }
            barrier.wait();
        }
        let observations = readers
            .into_iter()
            .map(|reader| reader.join().expect("manifest reader panicked"))
            .collect::<Vec<_>>();
        assert!(
            publication_error.is_none() && observations.iter().all(|(_, error)| error.is_none()),
            "publication={publication_error:?}; readers={observations:?}",
        );
    });
}
