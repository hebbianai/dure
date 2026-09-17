//! The phone's **public** key, and the one `authorized_keys` line built from it.
//!
//! Three secrets are in play across this feature and conflating them is the
//! main way to get it wrong. This module handles exactly one of them: the
//! phone's *public* key, the thing that is meant to be distributed. The other
//! two never appear here — the Host's `capability_token` is read locally by
//! `hmux mobile-gateway` on the far side and never crosses a network, and the
//! pairing token lives in [`super::token`] and is never written to disk.
//!
//! A private key is not "unusual input" here, it is an attack or a mistake, and
//! either way the answer is refusal: accepting one would mean hmux transported
//! and stored a credential whose entire security model is that it never leaves
//! the device that generated it. So the private-key check runs against the raw
//! request bytes *before* parsing, before the token is even examined, and there
//! is no code path that writes the offending bytes anywhere.

use base64::Engine as _;
use hmux_client::online_pairing::contains_private_key_material;
use sha2::{Digest as _, Sha256};

/// Key algorithms an entry may carry.
///
/// An allow-list, not a deny-list: an unknown algorithm name is a key we cannot
/// fingerprint or reason about, and writing it into `authorized_keys` anyway
/// would mean the file gained a line whose meaning we do not know.
const ACCEPTED_ALGORITHMS: &[&str] = &[
    "ssh-ed25519",
    "sk-ssh-ed25519@openssh.com",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
    "sk-ecdsa-sha2-nistp256@openssh.com",
    "ssh-rsa",
];

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum KeyRefusal {
    /// The payload carries private key material.
    PrivateKeyMaterial,
    /// Not a single-line `<algorithm> <base64> [comment]` public key.
    Malformed(&'static str),
    /// A known-shaped key whose algorithm is not on the allow-list.
    UnsupportedAlgorithm,
}

impl KeyRefusal {
    pub(crate) fn reason(&self) -> &'static str {
        match self {
            Self::PrivateKeyMaterial => "private_key_material",
            Self::Malformed(_) => "malformed_public_key",
            Self::UnsupportedAlgorithm => "unsupported_key_algorithm",
        }
    }

    pub(crate) fn detail(&self) -> &'static str {
        match self {
            Self::PrivateKeyMaterial => {
                "pairing accepts a public key only; a private key was refused and not stored"
            }
            Self::Malformed(detail) => detail,
            Self::UnsupportedAlgorithm => "the key algorithm is not on the accepted list",
        }
    }
}

/// Refuses a payload that contains private key material anywhere in it.
///
/// Run this against the raw request bytes before any parsing: the point is that
/// a private key never reaches a parser, a log line, or the device registry.
pub(crate) fn refuse_private_key_material(raw: &[u8]) -> Result<(), KeyRefusal> {
    if contains_private_key_material(raw) {
        return Err(KeyRefusal::PrivateKeyMaterial);
    }
    Ok(())
}

/// A validated OpenSSH public key: algorithm, wire blob, and fingerprint.
#[derive(Clone, Debug)]
pub(crate) struct PhonePublicKey {
    algorithm: String,
    encoded: String,
    fingerprint: String,
}

impl PhonePublicKey {
    /// Parses `<algorithm> <base64> [comment]`, discarding the comment.
    ///
    /// The comment is dropped rather than preserved because it is attacker-
    /// controlled free text that would land verbatim in `authorized_keys`; the
    /// comment we write instead names the paired device, which is what makes
    /// revocation a lookup rather than a guess.
    pub(crate) fn parse(candidate: &str) -> Result<Self, KeyRefusal> {
        refuse_private_key_material(candidate.as_bytes())?;
        if candidate.contains('\n') || candidate.contains('\r') {
            return Err(KeyRefusal::Malformed(
                "a public key must be one line; the request contained a line break",
            ));
        }
        let mut fields = candidate.split_ascii_whitespace();
        let algorithm = fields
            .next()
            .ok_or(KeyRefusal::Malformed("the public key was empty"))?;
        let encoded = fields.next().ok_or(KeyRefusal::Malformed(
            "the public key carried no base64 body",
        ))?;
        if !ACCEPTED_ALGORITHMS.contains(&algorithm) {
            return Err(KeyRefusal::UnsupportedAlgorithm);
        }
        let blob = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| KeyRefusal::Malformed("the public key body was not valid base64"))?;
        // The algorithm name is repeated inside the blob. Checking that the two
        // agree is what stops a caller from labelling an RSA key `ssh-ed25519`
        // to slip past the allow-list — sshd reads the blob, not the label.
        if embedded_algorithm(&blob).as_deref() != Some(algorithm) {
            return Err(KeyRefusal::Malformed(
                "the public key body does not describe the algorithm it claims",
            ));
        }
        Ok(Self {
            algorithm: algorithm.to_string(),
            encoded: encoded.to_string(),
            fingerprint: format!(
                "SHA256:{}",
                base64::engine::general_purpose::STANDARD_NO_PAD.encode(Sha256::digest(&blob))
            ),
        })
    }

    pub(crate) fn fingerprint(&self) -> &str {
        &self.fingerprint
    }
}

/// Reads the length-prefixed algorithm name out of an SSH public key blob.
fn embedded_algorithm(blob: &[u8]) -> Option<String> {
    let length = u32::from_be_bytes(blob.get(..4)?.try_into().ok()?) as usize;
    let name = blob.get(4..4 + length)?;
    String::from_utf8(name.to_vec()).ok()
}

/// The default forced command.
///
/// `$HOME` is expanded by the login shell sshd runs the forced command through,
/// and the path matches what `scripts/provision-hmux-remote.mjs` installs, so a
/// freshly provisioned server and a hand-installed one land on the same line.
/// The inner quotes survive into the shell so a home directory containing a
/// space does not split the command.
///
/// # Why it carries no `--session`
///
/// It cannot, and the cost of pretending otherwise was a fleet of dead keys.
/// sshd *replaces* the client's argv with this line, so a phone can append
/// nothing: with `--session` required, `hmux mobile-gateway` exited 2 on every
/// connection — for listing and attaching alike — and the single key pairing
/// installs could do nothing at all. Pinning a session id here instead would
/// stale out the moment the Host is replaced, and pairing is meant to happen
/// once.
///
/// So this line is unpinned on purpose, and it is the widening the project owner
/// approved: the key reaches every Hmux session that account owns on that host.
/// `restrict` and the forced command still hold — no shell, no port forwarding,
/// no other program — and `hmux pair revoke` removes the key from every host it
/// was installed on. An operator who wants the narrow thing appends
/// `--session <id>` by hand and accepts that it dies with the next Host.
///
/// This constant is not a documentation string: it is the literal text written
/// into `authorized_keys`, so a change here is a change to a line sshd will
/// execute. `tests/forced_command_gateway.rs` drives it through a real sshd
/// rather than asserting about its spelling, because a default that only *looks*
/// right fails hours later on someone else's phone.
///
/// # Why it is shared with the client rather than spelled twice
///
/// The relay client sends its own SSH command, and where a forced command
/// applies that string is discarded — so the two can differ for a long time
/// without anyone noticing. They stop being interchangeable the moment
/// something other than `authorized_keys` authenticates the connection, and
/// then the *client's* spelling is the one that runs. One constant, so the
/// case nobody tests cannot be the case where they disagree.
pub(crate) const DEFAULT_FORCED_COMMAND: &str = hmux_client::gateway_invocation::GATEWAY_INVOCATION;

/// One `authorized_keys` line: options, key, and a device-naming comment.
#[derive(Clone, Debug)]
pub(crate) struct AuthorizedKeyEntry {
    line: String,
}

impl AuthorizedKeyEntry {
    /// Builds the line for `key`, restricted and forced.
    ///
    /// **Both options, always.** The forced command is what stops a shell from
    /// opening; `restrict` is what stops the rest. Without `restrict` the entry
    /// is still a port-forwarding pivot into that server's network — the phone
    /// could open `-L`/`-R`/SOCKS tunnels and reach anything the server can
    /// reach, with no shell involved and nothing in the forced command able to
    /// prevent it. A forced command alone reads as safe and is not.
    pub(crate) fn build(
        key: &PhonePublicKey,
        forced_command: &str,
        device_id: &str,
    ) -> Result<Self, KeyRefusal> {
        if forced_command.contains('\n') || forced_command.contains('\r') {
            return Err(KeyRefusal::Malformed("a forced command must be one line"));
        }
        let line = format!(
            "command=\"{}\",restrict {} {} {}",
            escape_option_value(forced_command),
            key.algorithm,
            key.encoded,
            device_comment(device_id),
        );
        Ok(Self { line })
    }

    pub(crate) fn line(&self) -> &str {
        &self.line
    }
}

/// Comment naming the paired device, so `grep` on a server answers "whose key
/// is this" without consulting the laptop that installed it.
pub(crate) fn device_comment(device_id: &str) -> String {
    format!("hmux-pairing:{device_id}")
}

/// Escapes a value for an `authorized_keys` `command="…"` option.
///
/// sshd unescapes `\"` and `\\` inside the quoted value; leaving a raw quote in
/// would terminate the option early and turn the remainder of the command into
/// further option text.
fn escape_option_value(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        if character == '"' || character == '\\' {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real ed25519 public key blob: `ssh-ed25519` name plus a 32-byte key.
    fn sample_public_key() -> String {
        let mut blob = Vec::new();
        blob.extend_from_slice(&(b"ssh-ed25519".len() as u32).to_be_bytes());
        blob.extend_from_slice(b"ssh-ed25519");
        blob.extend_from_slice(&32u32.to_be_bytes());
        blob.extend_from_slice(&[7u8; 32]);
        format!(
            "ssh-ed25519 {} phone@desk",
            base64::engine::general_purpose::STANDARD.encode(&blob)
        )
    }

    #[test]
    fn a_private_key_is_refused_rather_than_tolerated() {
        let request = br#"{"public_key":"-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blb..."}"#;
        assert_eq!(
            refuse_private_key_material(request),
            Err(KeyRefusal::PrivateKeyMaterial)
        );
        assert_eq!(
            PhonePublicKey::parse("-----BEGIN OPENSSH PRIVATE KEY-----").unwrap_err(),
            KeyRefusal::PrivateKeyMaterial
        );
    }

    #[test]
    fn a_private_key_hidden_in_another_field_is_still_refused() {
        let request =
            br#"{"device_name":"my rsa PRIVATE KEY backup","public_key":"ssh-ed25519 AAAA"}"#;
        assert_eq!(
            refuse_private_key_material(request),
            Err(KeyRefusal::PrivateKeyMaterial)
        );
    }

    #[test]
    fn a_key_whose_body_contradicts_its_label_is_refused() {
        let honest = sample_public_key();
        let body = honest.split_ascii_whitespace().nth(1).unwrap();
        let mislabelled = format!("ssh-rsa {body} phone");
        assert!(matches!(
            PhonePublicKey::parse(&mislabelled).unwrap_err(),
            KeyRefusal::Malformed(_)
        ));
    }

    #[test]
    fn a_two_line_public_key_is_refused() {
        let injected = format!("{}\nssh-ed25519 AAAA attacker", sample_public_key());
        assert!(matches!(
            PhonePublicKey::parse(&injected).unwrap_err(),
            KeyRefusal::Malformed(_)
        ));
    }

    #[test]
    fn the_entry_carries_both_the_forced_command_and_restrict() {
        let key = PhonePublicKey::parse(&sample_public_key()).unwrap();
        let entry = AuthorizedKeyEntry::build(&key, DEFAULT_FORCED_COMMAND, "device-1").unwrap();
        let line = entry.line();
        // Split at the key so the assertions are about the *option* field
        // rather than about the line containing the words somewhere.
        let (options, key) = line
            .split_once(" ssh-ed25519 ")
            .expect("the entry carries options followed by the key");
        assert!(
            options.contains("command=\""),
            "a forced command is what stops a shell opening: {line}"
        );
        assert!(
            options.contains("mobile-gateway"),
            "the forced command must name the gateway: {line}"
        );
        assert!(
            options.contains("restrict"),
            "restrict must be an option on the entry, not decoration: {line}"
        );
        assert!(!key.is_empty());
        assert!(line.ends_with("hmux-pairing:device-1"));
        assert!(!line.contains('\n'));
    }

    #[test]
    fn a_forced_command_containing_quotes_is_escaped_into_the_option() {
        let key = PhonePublicKey::parse(&sample_public_key()).unwrap();
        let entry = AuthorizedKeyEntry::build(&key, DEFAULT_FORCED_COMMAND, "device-1").unwrap();
        assert!(
            entry
                .line()
                .starts_with("command=\"\\\"$HOME/.local/bin/hmux\\\" mobile-gateway\",restrict "),
            "unescaped quotes would end the option early: {}",
            entry.line()
        );
    }

    #[test]
    fn the_default_forced_command_is_an_invocation_that_actually_runs() {
        // The failure this guards is not a typo, it is a *category*: a forced
        // command replaces the client's argv, so anything this line requires and
        // does not supply can never be supplied by anyone. The previous contract
        // made `--session` required unless `--list` was present, which turned
        // this exact default into a key that exited 2 on every connection —
        // observed on two real servers after a successful pairing.
        //
        // So the argv this line hands the binary is parsed here, by the same
        // clap definition the process runs. `tests/forced_command_gateway.rs`
        // drives the same literal through a real sshd, because parsing is
        // necessary and not sufficient: a `command=` line can also fail on
        // quoting, on `restrict`, or on the path.
        let mut words = DEFAULT_FORCED_COMMAND.split_ascii_whitespace();
        let program = words
            .next()
            .expect("the default forced command must name a program");
        assert_eq!(
            program, "\"$HOME/.local/bin/hmux\"",
            "the program must stay quoted so a home directory with a space survives"
        );
        let mut argv = vec!["hmux"];
        argv.extend(words);
        assert_eq!(
            argv,
            vec!["hmux", "mobile-gateway"],
            "the default takes no arguments on purpose: every one of them would \
             be an argument the phone cannot supply"
        );
        let parsed = <crate::Cli as clap::Parser>::try_parse_from(&argv).unwrap_or_else(|error| {
            panic!("the default forced command must parse or pairing installs a dead key: {error}")
        });
        let crate::Command::MobileGateway(args) = parsed.command else {
            panic!("the default forced command must reach the gateway, not another subcommand");
        };
        // Unpinned by design — the widening the owner approved. Asserted rather
        // than assumed so a future edit that re-pins a session id here has to
        // change this test and read why.
        assert!(args.session.is_none());
        assert!(!args.list);
    }

    #[test]
    fn the_comment_the_phone_supplied_is_discarded() {
        let key = PhonePublicKey::parse(&sample_public_key()).unwrap();
        let entry = AuthorizedKeyEntry::build(&key, DEFAULT_FORCED_COMMAND, "device-1").unwrap();
        assert!(!entry.line().contains("phone@desk"));
    }
}
