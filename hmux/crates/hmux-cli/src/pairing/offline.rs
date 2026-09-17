//! `hmux pair offline` — the laptop half of pairing with no channel to the phone.
//!
//! [`super::start`] runs a listener and waits for the phone to prove a token.
//! This does not: it generates the key pair itself, installs the public half on
//! every server, and seals the private half and the server list into a QR that
//! the phone reads with no network of any kind.
//!
//! Its own subcommand rather than a `--offline` flag on `start`, because
//! `--address`, `--port`, `--ttl-seconds` and `--host-key` all describe a
//! listener that this flow never opens. A flag that silently voids four other
//! flags is a flag whose `--help` lies.
//!
//! # Ordering
//!
//! The revocation record is written before the first server is touched, for the
//! same reason as the online flow: a process that dies mid-fleet must leave
//! behind a key that `hmux pair revoke` can still reach. Here it matters more,
//! not less — there is no phone on the other end to notice that pairing never
//! finished.
//!
//! # What is printed, and why together
//!
//! The QR and the code go to the same screen at the same time, and the code is
//! never written anywhere else. Putting it in a file, a log, or a second
//! command's output would recreate exactly the artefact the code exists to
//! avoid: a copy of the credential that outlives the moment at the desk.

use super::devices::{DeviceRegistry, PairedDevice};
use super::entry::{AuthorizedKeyEntry, PhonePublicKey};
use super::installer::SshExecInstaller;
use super::inventory::{self, InventoryHost};
use super::qr;
use crate::CliError;
use base64::Engine as _;
use hmux_client::offline_pairing::{
    CODE_ALPHABET, CODE_LENGTH, OfflineHost, OfflinePairingContents, SEED_BYTES, seal,
};
use std::path::PathBuf;
use std::time::SystemTime;

const SALT_BYTES: usize = 16;
const NONCE_BYTES: usize = 24;

#[derive(clap::Args, Debug)]
pub(crate) struct PairOfflineArgs {
    /// A name for this device, shown by `hmux pair list`.
    #[arg(long, value_name = "NAME", default_value = "phone")]
    pub(crate) device_name: String,

    /// Forced command written into every authorized_keys entry.
    #[arg(long, value_name = "COMMAND", default_value = super::entry::DEFAULT_FORCED_COMMAND)]
    pub(crate) forced_command: String,

    /// The hmux to invoke on each remote server.
    #[arg(long, value_name = "COMMAND", default_value = super::installer::DEFAULT_REMOTE_HMUX)]
    pub(crate) remote_hmux: String,

    /// The desktop app's exported host inventory.
    #[arg(long, value_name = "PATH")]
    pub(crate) inventory: Option<PathBuf>,

    /// Also print the sealed payload as text.
    ///
    /// Off by default and worth keeping off: the payload plus the code is the
    /// credential, and text in a scrollback buffer is a copy of half of it that
    /// nobody remembers making.
    #[arg(long)]
    pub(crate) print_payload: bool,
}

/// Random bytes from the OS.
///
/// Not a seeded generator: everything this fills — the key seed, the salt, the
/// nonce, the code — is a secret whose only protection is that nobody can
/// predict it.
fn random_bytes(into: &mut [u8]) -> Result<(), CliError> {
    // `getrandom` rather than a seeded generator from `rand`: this is the OS
    // entropy source directly, with no user-space state that a fork or a
    // snapshot could duplicate. A pairing that produced the same key seed twice
    // would hand two phones one identity and make `revoke` ambiguous.
    getrandom::fill(into)
        .map_err(|error| CliError(format!("could not read system randomness: {error}")))
}

/// A code of [`CODE_LENGTH`] characters drawn uniformly from [`CODE_ALPHABET`].
///
/// Rejection sampling rather than `byte % 32`. The alphabet happens to be 32
/// long, so a modulo would be unbiased today — and would silently become biased
/// the day someone changes the alphabet's length to anything that does not
/// divide 256. The bias would not be visible in any output.
fn generate_code() -> Result<String, CliError> {
    let modulus = u8::try_from(CODE_ALPHABET.len()).expect("the alphabet fits in a byte");
    let ceiling = u8::MAX - (u8::MAX % modulus);
    let mut code = String::with_capacity(CODE_LENGTH);
    let mut buffer = [0u8; 1];
    while code.len() < CODE_LENGTH {
        random_bytes(&mut buffer)?;
        if buffer[0] >= ceiling {
            continue;
        }
        code.push(char::from(CODE_ALPHABET[usize::from(buffer[0] % modulus)]));
    }
    Ok(code)
}

/// The OpenSSH one-line public key for an ed25519 seed.
///
/// Built here rather than pulled from a key-format crate because the encoding
/// is two length-prefixed strings and the alternative is another dependency in
/// the musl artifact's tree.
fn openssh_public_key(seed: &[u8; SEED_BYTES]) -> String {
    let signing = ed25519_dalek::SigningKey::from_bytes(seed);
    let public = signing.verifying_key();
    const ALGORITHM: &[u8] = b"ssh-ed25519";
    let mut blob = Vec::with_capacity(4 + ALGORITHM.len() + 4 + SEED_BYTES);
    blob.extend_from_slice(&u32::try_from(ALGORITHM.len()).expect("fits").to_be_bytes());
    blob.extend_from_slice(ALGORITHM);
    blob.extend_from_slice(&u32::try_from(SEED_BYTES).expect("fits").to_be_bytes());
    blob.extend_from_slice(public.as_bytes());
    format!(
        "ssh-ed25519 {}",
        base64::engine::general_purpose::STANDARD.encode(&blob)
    )
}

pub(crate) fn run(args: PairOfflineArgs, json: bool) -> super::CommandResult {
    let inventory_path = match args.inventory {
        Some(path) => path,
        None => inventory::default_inventory_path()?,
    };
    let hosts = inventory::load_configured_hosts(&inventory_path)?;
    if hosts.is_empty() {
        return Err(CliError(format!(
            "no SSH hosts in {}; pairing would hand the phone an empty list",
            inventory_path.display()
        ))
        .into());
    }

    let mut seed = [0u8; SEED_BYTES];
    random_bytes(&mut seed)?;
    let public_key_line = openssh_public_key(&seed);
    let key = PhonePublicKey::parse(&public_key_line)
        .map_err(|refusal| CliError(format!("generated key was refused: {}", refusal.detail())))?;

    let device_id = uuid::Uuid::new_v4().to_string();
    let key_entry = AuthorizedKeyEntry::build(&key, &args.forced_command, &device_id)
        .map_err(|refusal| CliError(format!("could not build the entry: {}", refusal.detail())))?;

    let home = dirs::home_dir().ok_or_else(|| CliError("no home directory".into()))?;
    let mut registry = DeviceRegistry::acquire(DeviceRegistry::default_path()?, None)?;

    // Durable before the first destructive edit, exactly as in the online flow.
    // More important here: no phone is waiting, so a half-installed fleet has
    // nobody to report to except this record.
    let mut device = PairedDevice {
        device_id: device_id.clone(),
        device_name: args.device_name.clone(),
        fingerprint: key.fingerprint().to_string(),
        authorized_keys_entry: key_entry.line().to_string(),
        paired_at_unix_ms: super::unix_millis(SystemTime::now()),
        hosts: hosts.iter().map(super::pending_record).collect(),
    };
    registry.persist(&device).map_err(|error| {
        CliError(format!(
            "nothing was installed: pairing refuses to distribute a key it could not record for \
             revocation ({})",
            error.0
        ))
    })?;

    let installer = SshExecInstaller::new(home, args.remote_hmux, None);
    let mut sealed_hosts = Vec::with_capacity(hosts.len());
    let mut failures = Vec::new();
    for (index, host) in hosts.iter().enumerate() {
        let outcome = super::install_host(
            &mut registry,
            &mut device,
            index,
            host,
            key_entry.line(),
            &installer,
            None,
        );
        match outcome {
            super::HostInstallResult::Installed => {
                match device.hosts[index].host_key_fingerprint.clone() {
                    Some(fingerprint) => sealed_hosts.push(offline_host(host, fingerprint)),
                    // Installed, but the phone cannot pin it. Carried as a
                    // failure rather than shipped with an empty fingerprint:
                    // the phone refuses an unpinned host anyway, and a row it
                    // silently cannot use is worse than a row it never got.
                    None => failures.push((
                        host.name.clone(),
                        "installed, but the server's host key could not be read, so the phone has \
                         nothing to pin"
                            .to_string(),
                    )),
                }
            }
            super::HostInstallResult::Failed(error) => {
                failures.push((host.name.clone(), error));
            }
        }
    }

    if sealed_hosts.is_empty() {
        report_failures(&failures)?;
        return Err(CliError(
            "no server accepted the key, so there is nothing to pair with".into(),
        )
        .into());
    }

    let code = generate_code()?;
    let mut salt = [0u8; SALT_BYTES];
    let mut nonce = [0u8; NONCE_BYTES];
    random_bytes(&mut salt)?;
    random_bytes(&mut nonce)?;
    let payload = seal(
        &OfflinePairingContents {
            private_key_seed: seed,
            hosts: sealed_hosts.clone(),
        },
        &code,
        &salt,
        &nonce,
    )
    .map_err(|error| CliError(format!("could not seal the pairing payload: {error}")))?;

    if json {
        // The code is omitted on purpose. `--json` output is piped and logged,
        // and a code in a log is the copy this design exists to prevent.
        crate::output::writeln(format_args!(
            "{}",
            serde_json::json!({
                "device_id": device_id,
                "device_name": args.device_name,
                "fingerprint": key.fingerprint(),
                "installed": sealed_hosts.iter().map(|host| &host.id).collect::<Vec<_>>(),
                "failed": failures.iter().map(|(name, _)| name).collect::<Vec<_>>(),
                "code_shown_on_terminal_only": true,
            })
        ))?;
        return Ok(());
    }

    let symbol = qr::render(&payload).map_err(|error| {
        // A payload too large for a symbol is a fleet too large for this
        // flow, and saying so beats printing a QR nothing can read.
        CliError(format!(
            "the pairing payload does not fit a QR ({error}); pair fewer servers at once"
        ))
    })?;
    crate::output::writeln(format_args!("{symbol}"))?;
    crate::output::writeln(format_args!("  Code:  {code}"))?;
    crate::output::writeln(format_args!(""))?;
    crate::output::writeln(format_args!(
        "  This code is shown only on this screen and is not stored anywhere."
    ))?;
    crate::output::writeln(format_args!(
        "  Scan the QR code, then enter these 6 characters on your phone."
    ))?;
    crate::output::writeln(format_args!(""))?;
    crate::output::writeln(format_args!(
        "  Servers with installed keys: {}",
        sealed_hosts.len()
    ))?;
    for host in &sealed_hosts {
        crate::output::writeln(format_args!(
            "    {} ({}@{})",
            host.label, host.username, host.host
        ))?;
    }
    report_failures(&failures)?;
    crate::output::writeln(format_args!(""))?;
    crate::output::writeln(format_args!("  To revoke:  hmux pair revoke {device_id}"))?;
    if args.print_payload {
        crate::output::writeln(format_args!(""))?;
        crate::output::writeln(format_args!("  payload: {payload}"))?;
    }
    Ok(())
}

fn offline_host(host: &InventoryHost, fingerprint: String) -> OfflineHost {
    OfflineHost {
        id: host.id.clone(),
        label: host.name.clone(),
        host: host.host.clone(),
        port: host.port,
        username: host.user.clone(),
        host_key_fingerprint: fingerprint,
    }
}

/// Named, never omitted. A server that quietly disappears from the list reads
/// exactly like a server that was never configured, and the one the owner came
/// to the desk for is the one that will have failed.
fn report_failures(failures: &[(String, String)]) -> super::CommandResult {
    if failures.is_empty() {
        return Ok(());
    }
    crate::output::writeln(format_args!(""))?;
    crate::output::writeln(format_args!("  Unreachable servers: {}", failures.len()))?;
    for (name, detail) in failures {
        crate::output::writeln(format_args!("    {name}: {detail}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use hmux_client::offline_pairing::{normalize_code, open};

    #[test]
    fn a_generated_code_is_the_documented_length_and_alphabet() {
        for _ in 0..64 {
            let code = generate_code().expect("randomness is available");
            assert_eq!(code.len(), CODE_LENGTH);
            assert!(
                code.bytes().all(|byte| CODE_ALPHABET.contains(&byte)),
                "{code} left the alphabet"
            );
            // Round-trips through the phone's own normaliser, which is what
            // actually decides whether a typed code can open the payload.
            assert_eq!(normalize_code(&code).as_deref(), Some(code.as_str()));
        }
    }

    /// The public key the servers receive and the seed the QR carries have to
    /// be halves of one key, or pairing installs a lock whose key is elsewhere.
    /// Asserted through the same parser `authorized_keys` entries go through.
    #[test]
    fn the_installed_public_key_belongs_to_the_seed_the_qr_carries() {
        let seed = [42u8; SEED_BYTES];
        let line = openssh_public_key(&seed);

        let parsed = PhonePublicKey::parse(&line).expect("a well-formed ed25519 key");

        // Decoded rather than searched for as a substring: base64 of a slice is
        // not a slice of base64 unless it happens to land on a 3-byte boundary,
        // so a `contains` check here passes or fails on alignment rather than on
        // the property. Decoding also asserts the wire framing itself, which is
        // what sshd actually reads.
        let blob = base64::engine::general_purpose::STANDARD
            .decode(line.split_whitespace().nth(1).expect("a base64 field"))
            .expect("the body is base64");
        let expected = ed25519_dalek::SigningKey::from_bytes(&seed)
            .verifying_key()
            .to_bytes();
        let mut wanted = Vec::new();
        wanted.extend_from_slice(&11u32.to_be_bytes());
        wanted.extend_from_slice(b"ssh-ed25519");
        wanted.extend_from_slice(&32u32.to_be_bytes());
        wanted.extend_from_slice(&expected);
        assert_eq!(
            blob, wanted,
            "the installed key must be this seed's public half, framed as sshd reads it"
        );
        assert!(parsed.fingerprint().starts_with("SHA256:"));
    }

    /// End to end through the real seal and the real open: what the laptop
    /// prints is what the phone can use.
    #[test]
    fn what_this_command_seals_is_what_a_phone_opens() {
        let seed = [9u8; SEED_BYTES];
        let code = generate_code().expect("randomness");
        let contents = OfflinePairingContents {
            private_key_seed: seed,
            hosts: vec![OfflineHost {
                id: "gate1".into(),
                label: "Gate1".into(),
                host: "192.0.2.10".into(),
                port: 22,
                username: "gate1".into(),
                host_key_fingerprint: "SHA256:abc".into(),
            }],
        };
        let payload =
            seal(&contents, &code, &[1u8; SALT_BYTES], &[2u8; NONCE_BYTES]).expect("seal");

        let opened = open(&payload, &code).expect("the printed code opens the printed QR");

        assert_eq!(opened, contents);
        // And the public key that went into authorized_keys matches what the
        // phone just received, which is the only thing that makes the pairing
        // usable at all.
        assert_eq!(
            openssh_public_key(&opened.private_key_seed),
            openssh_public_key(&seed)
        );
    }
}
