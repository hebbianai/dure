use super::*;
use sha2::{Digest, Sha256};

const PASSWORD: &str = "fixture 암호화 secret";
const MARKER: &str = "암호화 전용 값 583";
const SAVE: &str = "encrypted-state-save-proof";

async fn encrypted(
    home: &Path,
    target: (&str, &str, &str),
    arguments: &[&str],
    key: (&str, &str),
) -> Result<Value, String> {
    let (resource, page, epoch) = target;
    let mut args = vec![
        "state",
        resource,
        "--page",
        page,
        "--controller",
        "agent-proof",
        "--epoch",
        epoch,
    ];
    args.extend_from_slice(arguments);
    super::super::cli_with_environment(home, &args, None, Some(key)).await
}

fn contains(bytes: &[u8], value: &str) -> bool {
    bytes
        .windows(value.len())
        .any(|window| window == value.as_bytes())
}

pub(super) async fn exercise(
    home: &Path,
    resource: &str,
    page: &str,
    epoch: &str,
    origins: (&str, &str),
    isolated: (&str, &str, &str),
) -> Result<(), String> {
    let (origin, other_origin) = origins;
    let (other, other_page, other_epoch) = isolated;
    let target = (resource, page, epoch);
    let key = ("DURE_BROWSER_ENCRYPTION_KEY", PASSWORD);
    let derived = format!("{:x}", Sha256::digest(PASSWORD.as_bytes()));
    write(home, resource, page, epoch, "goto", &[origin]).await?;
    write(
        home,
        resource,
        page,
        epoch,
        "storage",
        &["local", "set", "encrypted-first", MARKER],
    )
    .await?;
    write(
        home,
        resource,
        page,
        epoch,
        "cookie",
        &["set", "encrypted-cookie", "cipher-cookie", "--http-only"],
    )
    .await?;
    write(home, resource, page, epoch, "goto", &[other_origin]).await?;
    write(
        home,
        resource,
        page,
        epoch,
        "storage",
        &["local", "set", "encrypted-second", MARKER],
    )
    .await?;
    write(
        home,
        resource,
        page,
        epoch,
        "storage",
        &["session", "set", "encrypted-session", MARKER],
    )
    .await?;
    let plain_path = home.join("encrypted-state.json");
    let cipher_path = home.join("encrypted-state.json.enc");
    let saved = encrypted(
        home,
        target,
        &[
            "save",
            plain_path.to_str().unwrap(),
            "--idempotency-key",
            SAVE,
        ],
        key,
    )
    .await?;
    require(
        saved["result"]["response"]["data"]["encrypted"] == true,
        &saved,
    )?;
    require(
        !plain_path.exists(),
        "encrypted export wrote a plaintext file",
    )?;
    let bytes = tokio::fs::read(&cipher_path)
        .await
        .map_err(|e| e.to_string())?;
    require(
        !contains(&bytes, MARKER) && !contains(&bytes, PASSWORD) && !contains(&bytes, &derived),
        "export contains a plaintext value or key",
    )?;
    let hash = format!("{:x}", Sha256::digest(SAVE.as_bytes()));
    let stored = home.join("backend/browser-results");
    require(
        tokio::fs::read(stored.join(format!("{hash}.artifact")))
            .await
            .map_err(|e| e.to_string())?
            == bytes,
        "server did not persist the exact ciphertext",
    )?;
    let payload = tokio::fs::read(stored.join(format!("{hash}.json")))
        .await
        .map_err(|e| e.to_string())?;
    let receipt = cli(home, &["receipt", SAVE]).await?;
    for result in [
        payload,
        serde_json::to_vec(&saved).unwrap(),
        serde_json::to_vec(&receipt).unwrap(),
    ] {
        require(
            !contains(&result, MARKER)
                && !contains(&result, PASSWORD)
                && !contains(&result, &derived),
            "result or receipt persisted state content or key",
        )?;
    }
    // An independent implementation reads Rust's nonce + ciphertext + tag.
    // Plaintext stays in the child process memory; only the verdict is printed.
    let output = timeout(Duration::from_secs(10), tokio::process::Command::new("node")
        .args(["--input-type=module", "-e", r#"
import {createHash,createDecipheriv} from 'node:crypto';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const data=readFileSync(process.argv[1]);
const key=createHash('sha256').update(process.env.FIXTURE_STATE_PASSWORD,'utf8').digest();
const cipher=createDecipheriv('aes-256-gcm',key,data.subarray(0,12));
cipher.setAuthTag(data.subarray(-16));
const state=JSON.parse(Buffer.concat([cipher.update(data.subarray(12,-16)),cipher.final()]));
for(const name of ['encrypted-first','encrypted-second']) assert(state.origins.some(o=>o.localStorage.some(e=>e.name===name&&e.value==='암호화 전용 값 583')));
assert(state.origins.some(o=>o.sessionStorage.some(e=>e.name==='encrypted-session'&&e.value==='암호화 전용 값 583')));
assert(state.cookies.some(c=>c.name==='encrypted-cookie'&&c.httpOnly===true));
console.log('independent-decrypt-ok');
"#])
        .arg(&cipher_path).env("FIXTURE_STATE_PASSWORD", PASSWORD).kill_on_drop(true).output())
        .await.map_err(|_| "independent decrypt deadline")?.map_err(|e| e.to_string())?;
    require(
        output.status.success() && output.stdout == b"independent-decrypt-ok\n",
        "independent decryption failed",
    )?;
    let shown = super::super::cli_with_environment(
        home,
        &["state", "show", cipher_path.to_str().unwrap()],
        None,
        Some(key),
    )
    .await?;
    require(
        shown["result"]["encrypted"] == true
            && shown["result"]["state"]["origins"]
                .as_array()
                .is_some_and(|origins| {
                    origins.iter().any(|origin| {
                        origin["localStorage"].as_array().is_some_and(|entries| {
                            entries.iter().any(|entry| {
                                entry["name"] == "encrypted-first" && entry["value"] == MARKER
                            })
                        })
                    })
                }),
        "actual local state show could not decrypt native export",
    )?;
    let recovered_path = home.join("encrypted-recovered.enc");
    cli(
        home,
        &[
            "artifact",
            SAVE,
            "--output",
            recovered_path.to_str().unwrap(),
        ],
    )
    .await?;
    require(
        tokio::fs::read(&recovered_path)
            .await
            .map_err(|e| e.to_string())?
            == bytes,
        "keyless artifact recovery changed ciphertext",
    )?;

    // A rejected import must not navigate, touch either storage kind, or set cookies.
    eval(
        home,
        other,
        other_page,
        other_epoch,
        "window.encryptionGuard='retained';true",
    )
    .await?;
    let before_page = cli(home, &["show", other]).await?["result"]["pages"].clone();
    let before_cookies = read(home, other, other_page, "cookie", &["get"]).await?;
    let before_local = read(home, other, other_page, "storage", &["local", "get"]).await?;
    let before_session = read(home, other, other_page, "storage", &["session", "get"]).await?;
    let tampered_path = home.join("encrypted-tampered.enc");
    let mut tampered = bytes.clone();
    *tampered.last_mut().unwrap() ^= 1;
    tokio::fs::write(&tampered_path, &tampered)
        .await
        .map_err(|e| e.to_string())?;
    let truncated_path = home.join("encrypted-truncated.enc");
    tokio::fs::write(&truncated_path, &bytes[..27])
        .await
        .map_err(|e| e.to_string())?;
    for (index, (file, password)) in [
        (&cipher_path, "wrong fixture key"),
        (&tampered_path, PASSWORD),
        (&truncated_path, PASSWORD),
    ]
    .into_iter()
    .enumerate()
    {
        let operation = format!("encrypted-rejected-{index}");
        let rejected = encrypted(
            home,
            isolated,
            &[
                "load",
                file.to_str().unwrap(),
                "--idempotency-key",
                &operation,
            ],
            (key.0, password),
        )
        .await;
        require(
            rejected
                .as_ref()
                .is_err_and(|error| error.contains("browser_state_decryption_failed")),
            &rejected,
        )?;
        require(
            cli(home, &["show", other]).await?["result"]["pages"] == before_page,
            "rejected ciphertext changed page identity",
        )?;
        require(
            eval(
                home,
                other,
                other_page,
                other_epoch,
                "window.encryptionGuard",
            )
            .await?
                == "retained",
            "rejected ciphertext navigated",
        )?;
        require(
            read(home, other, other_page, "cookie", &["get"]).await? == before_cookies,
            "rejected ciphertext changed cookies",
        )?;
        require(
            read(home, other, other_page, "storage", &["local", "get"]).await? == before_local,
            "rejected ciphertext changed local storage",
        )?;
        require(
            read(home, other, other_page, "storage", &["session", "get"]).await? == before_session,
            "rejected ciphertext changed session storage",
        )?;
        let result_path = stored.join(format!("{:x}.json", Sha256::digest(operation.as_bytes())));
        let result = tokio::fs::read(result_path)
            .await
            .map_err(|e| e.to_string())?;
        require(
            !contains(&result, password)
                && !contains(
                    &result,
                    &format!("{:x}", Sha256::digest(password.as_bytes())),
                ),
            "rejected result persisted key",
        )?;
    }
    // The upstream alias and missing .json path both reach the same import.
    encrypted(
        home,
        isolated,
        &["load", plain_path.to_str().unwrap()],
        ("AGENT_BROWSER_ENCRYPTION_KEY", PASSWORD),
    )
    .await?;
    write(
        home,
        other,
        other_page,
        other_epoch,
        "goto",
        &[other_origin],
    )
    .await?;
    require(
        read(
            home,
            other,
            other_page,
            "storage",
            &["local", "get", "encrypted-second"],
        )
        .await?["value"]
            == MARKER,
        "second origin did not decrypt",
    )?;
    require(
        read(
            home,
            other,
            other_page,
            "storage",
            &["session", "get", "encrypted-session"],
        )
        .await?["value"]
            == MARKER,
        "session did not decrypt",
    )?;
    write(home, other, other_page, other_epoch, "goto", &[origin]).await?;
    require(
        read(
            home,
            other,
            other_page,
            "storage",
            &["local", "get", "encrypted-first"],
        )
        .await?["value"]
            == MARKER,
        "first origin did not decrypt",
    )?;
    require(
        read(home, other, other_page, "cookie", &["get"]).await?["cookies"]
            .as_array()
            .is_some_and(|cookies| {
                cookies.iter().any(|cookie| {
                    cookie["name"] == "encrypted-cookie" && cookie["httpOnly"] == true
                })
            }),
        "HTTP-only cookie did not decrypt",
    )?;
    let mut staged = 0;
    for entry in std::fs::read_dir(home.join("backend")).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_name().to_string_lossy().starts_with("upload-") {
            continue;
        }
        let file = entry.path().join("encrypted-state.json.enc");
        if file.exists() {
            require(
                tokio::fs::read(file).await.map_err(|e| e.to_string())? == bytes,
                "upload staging persisted decrypted content",
            )?;
            staged += 1;
        }
    }
    require(staged > 0, "encrypted upload staging not observed")?;
    write(home, resource, page, epoch, "cookie", &["clear"]).await?;
    println!(
        "BROWSER_STATE_ENCRYPTION_EVIDENCE {}",
        json!({"bytes":bytes.len(),"independentNodeDecrypt":true,"ciphertextArtifactAndUpload":true,"resultAndReceiptKeyAbsent":true,"keylessArtifactRecoveryExact":true,"badKeyTamperTruncationBeforeMutation":3,"crossOriginAndSessionRoundtrip":true,"upstreamEnvironmentAlias":true,"missingPlainPathFallback":true})
    );
    Ok(())
}
