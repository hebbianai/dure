use super::*;

#[derive(Default)]
struct SlowFleet {
    started: Mutex<Vec<String>>,
    mutated: Mutex<Vec<String>>,
}

impl AuthorizedKeyInstaller for SlowFleet {
    fn install(
        &self,
        host: &InventoryHost,
        _entry: &str,
        deadline: Option<Instant>,
        before_mutation: &mut dyn FnMut(&str) -> Result<(), String>,
    ) -> Result<bool, String> {
        self.started.lock().unwrap().push(host.id.clone());
        if host.id == "slow" {
            std::thread::sleep(deadline.unwrap().saturating_duration_since(Instant::now()));
        }
        before_mutation("SHA256:fixture-endpoint")?;
        self.mutated.lock().unwrap().push(host.id.clone());
        Ok(true)
    }

    fn revoke(
        &self,
        _host: &InventoryHost,
        _entry: &str,
        _expected_host_key_fingerprint: Option<&str>,
    ) -> Result<bool, String> {
        panic!("pairing does not start an implicit revocation");
    }
}

fn complete_with_deadline(
    hosts: &[InventoryHost],
    installer: &impl AuthorizedKeyInstaller,
    deadline: Instant,
) -> (PairingResponse, DeviceRegistryLease, tempfile::TempDir) {
    let now = SystemTime::now();
    let mut session = PairingSession::new(PairingToken::generate(), now, Duration::from_secs(120));
    let request = signed_request(session.token(), "phone", &phone_public_key());
    let verified = verify_request(&mut session, &request, now, deadline)
        .unwrap_or_else(|_| panic!("the phone proved its token"));
    let directory = tempfile::tempdir().unwrap();
    let mut registry =
        DeviceRegistry::acquire(directory.path().join("devices.json"), None).unwrap();
    let response = complete_after_lease(
        &session,
        hosts,
        PairingTerms {
            forced_command: entry::DEFAULT_FORCED_COMMAND,
            device_id: None,
        },
        installer,
        &mut registry,
        verified,
        now,
    );
    (response, registry, directory)
}

#[test]
fn an_expired_exchange_cannot_begin_even_while_its_qr_remains_valid() {
    let installer = SlowFleet::default();
    let (response, registry, _directory) = complete_with_deadline(
        &[remote_host("later", "later server")],
        &installer,
        Instant::now(),
    );
    assert!(
        installer.mutated.lock().unwrap().is_empty(),
        "an expired exchange installed a key after its waiting phone timed out"
    );
    assert_eq!(refusal(&response).reason, "pairing_deadline_elapsed");
    assert!(registry.devices().is_empty());
}

#[test]
fn one_slow_host_cannot_reset_the_remaining_fleet_budget() {
    let installer = SlowFleet::default();
    let hosts = [
        remote_host("ready", "ready server"),
        remote_host("slow", "slow server"),
        remote_host("later", "later server"),
    ];
    let (response, registry, _directory) =
        complete_with_deadline(&hosts, &installer, Instant::now() + Duration::from_secs(1));
    assert_eq!(
        *installer.mutated.lock().unwrap(),
        ["ready"],
        "a timed-out host or a later host must not mutate the fleet"
    );
    assert_eq!(*installer.started.lock().unwrap(), ["ready", "slow"]);
    assert_eq!(refusal(&response).reason, PAIRING_DEADLINE_ELAPSED);
    let record = &registry.devices()[0];
    assert_eq!(record.hosts.len(), 3, "partial installs remain revocable");
    assert!(record.hosts[0].installed);
    assert!(record.hosts[1..].iter().all(|host| {
        !host.installed && host.failure.as_deref() == Some(PAIRING_DEADLINE_ELAPSED)
    }));
}

#[test]
fn the_phone_and_laptop_observe_timeout_after_a_partial_fleet_install() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("devices.json");
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let now = SystemTime::now();
    let mut session = PairingSession::new(PairingToken::generate(), now, Duration::from_secs(120));
    let mut request = signed_request(session.token(), "phone", &phone_public_key());
    request.push(b'\n');
    let installer = SlowFleet::default();
    std::thread::scope(|scope| {
        let laptop = scope.spawn(|| {
            let (stream, _) = listener.accept().unwrap();
            connection::handle_connection(
                stream,
                &mut session,
                &[
                    remote_host("ready", "ready"),
                    remote_host("slow", "slow"),
                    remote_host("later", "later"),
                ],
                PairingTerms {
                    forced_command: entry::DEFAULT_FORCED_COMMAND,
                    device_id: None,
                },
                &installer,
                &path,
                Instant::now() + Duration::from_secs(1),
            )
        });
        let mut phone = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        phone
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        phone.write_all(&request).unwrap();
        let mut raw = Vec::new();
        BufReader::new(phone).read_until(b'\n', &mut raw).unwrap();
        let response: PairingResponse = serde_json::from_slice(&raw).unwrap();
        assert_eq!(refusal(&response).reason, PAIRING_DEADLINE_ELAPSED);
        assert!(
            laptop
                .join()
                .unwrap()
                .unwrap_err()
                .contains(PAIRING_DEADLINE_ELAPSED)
        );
    });
    assert_eq!(*installer.mutated.lock().unwrap(), ["ready"]);
    assert_eq!(*installer.started.lock().unwrap(), ["ready", "slow"]);
    let registry = DeviceRegistry::load(path).unwrap();
    assert_eq!(
        registry.devices()[0]
            .hosts
            .iter()
            .filter(|host| host.installed)
            .count(),
        1
    );
}

#[test]
fn the_registry_lease_wait_consumes_the_same_exchange_budget() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("devices.json");
    let lease = DeviceRegistry::acquire(path.clone(), None).unwrap();
    let release = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(1));
        drop(lease);
    });
    let started = Instant::now();
    let result = DeviceRegistry::acquire(path.clone(), Some(started + Duration::from_millis(100)));
    let elapsed = started.elapsed();
    release.join().unwrap();
    assert_eq!(result.unwrap_err().0, PAIRING_DEADLINE_ELAPSED);
    assert!(
        elapsed < Duration::from_millis(800),
        "the registry reset the exchange budget: {elapsed:?}"
    );
    assert!(
        DeviceRegistry::acquire(path, None)
            .unwrap()
            .devices()
            .is_empty()
    );
}
