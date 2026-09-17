//! Design Mode B단계: 사용자 앱을 별도 webview 창으로 열고 픽커를 주입한다.
//!
//! 왜 별도 창인가: iframe은 크로스오리진 DOM에 접근할 수 없고, 한 창에 여러
//! webview를 붙이는 API는 tauri `unstable` 뒤에 있으며 OS 레이어가 dockview의
//! 드래그·z-order·클리핑과 충돌한다. 창끼리는 그 다툼이 없다.
//!
//! 캡처를 어떻게 받는가: **페이지 URL 해시를 폴링한다.** 원격 오리진 페이지는 IPC를
//! 쓸 수 없고(ACL), 우리 오리진 iframe을 끼워도 마찬가지다 — Tauri는 IPC
//! 부트스트랩을 `for_main_frame_only: true`로만 주입하므로(2.11.5
//! manager/webview.rs:159-197) 서브프레임에는 invoke가 존재하지 않는다. 실기에서도
//! 캡처 0건으로 확인했다. 그래서 주입 스크립트가 자기 URL 해시에 조각을 쓰고 여기서
//! 모은다. 페이지 URL을 오염시키는 대가가 있지만 대안이 없다.

use std::collections::BTreeMap;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

use crate::screen_capture::{crop_args, png_size, window_number};

/// 이 창은 하나만 둔다 — 여러 개면 어느 캡처가 어디서 왔는지 사용자가 모른다.
pub const DESIGN_MODE_WINDOW_LABEL: &str = "dure-design-browser";
/// 메인 창이 받는 이벤트 이름.
pub const DESIGN_MODE_CAPTURE_EVENT: &str = "dure://design-mode/capture";

/// 열 수 있는 대상인지 — http(s)면 된다.
///
/// **주입은 loopback에만 한다**(is_loopback). 주입이 없으면 픽커도 nonce 채널도
/// 존재하지 않으므로 임의 사이트를 열어도 표면이 늘지 않는다. 반대로 주입까지
/// 임의 사이트에 하면 그 표면을 사이트 수만큼 늘리는 것이다.
fn is_loopback(url: &tauri::Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.to_ascii_lowercase();
    host == "localhost"
        || host == "127.0.0.1"
        || host == "::1"
        || host == "[::1]"
        || host.ends_with(".localhost")
}

fn validate_target(raw: &str) -> Result<tauri::Url, String> {
    let url = tauri::Url::parse(raw).map_err(|error| format!("invalid_url: {error}"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(format!("unsupported_scheme: {}", url.scheme()));
    }
    if url.host_str().is_none() {
        return Err("missing_host".to_string());
    }
    Ok(url)
}

/// 해시 조각 하나. 형식은 TS의 encodeHashChunks와 같아야 한다
/// (`dure-dm:<nonce>:<index>:<total>:<data>`) — 규칙이 갈라지면 조용히 아무것도
/// 도착하지 않는다.
#[derive(Debug, PartialEq)]
struct HashChunk {
    nonce: String,
    index: usize,
    total: usize,
    data: String,
}

fn parse_hash_chunk(hash: &str) -> Option<HashChunk> {
    let raw = hash.strip_prefix('#').unwrap_or(hash);
    let rest = raw.strip_prefix("dure-dm:")?;
    let mut parts = rest.splitn(4, ':');
    let nonce = parts.next()?.to_string();
    let index: usize = parts.next()?.parse().ok()?;
    let total: usize = parts.next()?.parse().ok()?;
    // data에도 ':'가 들어갈 수 있으므로 나머지 전부가 data다.
    let data = parts.next()?.to_string();
    if nonce.is_empty() || total == 0 || index >= total {
        return None;
    }
    Some(HashChunk {
        nonce,
        index,
        total,
        data,
    })
}

/// `encodeURIComponent`의 역. 의존성을 늘리지 않기 위해 직접 구현한다 — 잘못된
/// 시퀀스는 **버린다**(부분 복원은 잘린 요청을 만든다).
fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' => {
                let hex = input.get(index + 1..index + 3)?;
                out.push(u8::from_str_radix(hex, 16).ok()?);
                index += 3;
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

/// 모인 조각으로 페이로드를 복원한다. 빠진 조각이 있으면 None — 부분 페이로드를
/// 에이전트에게 보내면 조용히 잘린 요청이 된다.
fn join_chunks(nonce: &str, chunks: &BTreeMap<usize, String>, total: usize) -> Option<String> {
    if chunks.len() != total {
        return None;
    }
    let mut joined = String::new();
    for index in 0..total {
        joined.push_str(chunks.get(&index)?);
    }
    let _ = nonce;
    percent_decode(&joined)
}

/// 창의 URL 해시를 폴링해 조각을 모으고, 완성되면 메인 창으로 넘긴다.
///
/// 폴링 간격은 주입 쪽의 조각 쓰기 간격(120ms)보다 짧아야 한다. 같거나 길면 조각을
/// 건너뛰고, 그러면 영원히 완성되지 않는다.
const POLL_INTERVAL_MS: u64 = 40;

fn spawn_hash_poller<R: Runtime>(app: AppHandle<R>, nonce: String) {
    tauri::async_runtime::spawn(async move {
        let mut chunks: BTreeMap<usize, String> = BTreeMap::new();
        let mut expected_total: Option<usize> = None;
        let mut last_hash = String::new();
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(POLL_INTERVAL_MS)).await;
            let Some(window) = app.get_webview_window(DESIGN_MODE_WINDOW_LABEL) else {
                return; // 창이 닫혔다 — 폴링도 끝난다.
            };
            let Ok(url) = window.url() else { continue };
            let Some(fragment) = url.fragment() else { continue };
            if fragment == last_hash {
                continue;
            }
            last_hash = fragment.to_string();
            let Some(chunk) = parse_hash_chunk(fragment) else {
                continue;
            };
            // 우리가 발급한 nonce가 아닌 조각은 버린다 — 페이지의 다른 스크립트도
            // 해시를 쓴다.
            if chunk.nonce != nonce {
                continue;
            }
            if expected_total != Some(chunk.total) {
                chunks.clear();
                expected_total = Some(chunk.total);
            }
            chunks.insert(chunk.index, chunk.data);
            if let Some(total) = expected_total {
                if let Some(payload) = join_chunks(&nonce, &chunks, total) {
                    match serde_json::from_str::<Value>(&payload) {
                        Ok(value) => {
                            let _ = app.emit_to("main", DESIGN_MODE_CAPTURE_EVENT, value);
                        }
                        // 페이지가 만든 값이므로 깨질 수 있다. 조용히 버리지 않고
                        // 프론트가 볼 수 있게 오류로 넘긴다.
                        Err(error) => {
                            let _ = app.emit_to(
                                "main",
                                DESIGN_MODE_CAPTURE_EVENT,
                                serde_json::json!({
                                    "kind": "error",
                                    "body": { "reason": format!("payload_parse: {error}") }
                                }),
                            );
                        }
                    }
                    chunks.clear();
                    expected_total = None;
                }
            }
        }
    });
}

/// 사용자 앱 창을 열고(있으면 새 nonce로 다시 만들고) 픽커를 주입한다.
///
/// script는 프론트가 넘긴다 — 번들(src/generated/designModeInject.js)이 프론트
/// 자산이고, 그 안의 판정 로직이 앱과 같은 모듈이어야 하기 때문이다. Rust가
/// 별도 사본을 들면 두 벌이 되어 창마다 다른 결과가 나온다.
#[tauri::command]
pub async fn design_mode_open_browser<R: Runtime>(
    app: AppHandle<R>,
    url: String,
    script: String,
    nonce: String,
) -> Result<String, String> {
    let target = validate_target(&url)?;
    if script.trim().is_empty() {
        return Err("empty_injection_script".to_string());
    }
    if nonce.trim().is_empty() {
        return Err("empty_nonce".to_string());
    }
    // 주입·폴링은 loopback에서만. 그 밖은 평범한 브라우저 창이다.
    let inject = is_loopback(&target);
    let config = crate::webview_storage::window_config(
        app.config(),
        DESIGN_MODE_WINDOW_LABEL,
        WebviewUrl::External(target.clone()),
    )?;
    let builder = WebviewWindowBuilder::from_config(&app, &config)
    .map_err(|error| format!("create_window_failed: {error}"))?
    .title(if inject {
        format!("Design Mode — {target}")
    } else {
        target.to_string()
    })
    .inner_size(1200.0, 900.0)
    .min_inner_size(480.0, 360.0)
    .focused(true);
    let builder = if inject {
        builder.initialization_script(script)
    } else {
        builder
    };
    // Prepare the new configuration before retiring the previous nonce's window.
    if let Some(existing) = app.get_webview_window(DESIGN_MODE_WINDOW_LABEL) {
        let _ = existing.destroy();
    }
    builder
        .build()
        .map_err(|error| format!("create_window_failed: {error}"))?;
    if inject {
        spawn_hash_poller(app.clone(), nonce);
    }
    Ok(DESIGN_MODE_WINDOW_LABEL.to_string())
}

/// 집은 요소를 크롭해 PNG로 저장하고 경로를 돌려준다.
///
/// **창 자체를 찍는다**(`screencapture -l <CGWindowID>`). 화면 영역(`-R`)을 찍으면 그
/// 좌표 위에 다른 창이 있으면 그 창이 찍힌다 — 2026-07-30 실측에서 실제로 메인 앱
/// 창이 찍혔다. 창 캡처는 z-order와 무관하고 포커스를 훔칠 필요도 없다.
///
/// 크롭은 `sips`로 한다(macOS 내장) — 이미지 처리 의존성을 새로 넣지 않는다.
///
/// 실패는 치명적이지 않다: 권한이 없거나 window id를 못 얻으면 오류를 내고, 호출자는
/// 무시하고 진행한다(fail-open). 스크린샷 하나 때문에 캡처를 버리면 안 된다.
#[tauri::command]
pub async fn design_mode_screenshot<R: Runtime>(
    app: AppHandle<R>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<String, String> {
    if width < 1.0 || height < 1.0 {
        return Err("empty_rect".to_string());
    }
    let window = app
        .get_webview_window(DESIGN_MODE_WINDOW_LABEL)
        .ok_or_else(|| "window_missing".to_string())?;
    let scale = window
        .scale_factor()
        .map_err(|e| format!("scale_failed: {e}"))?;
    let inner_size = window
        .inner_size()
        .map_err(|e| format!("inner_size_failed: {e}"))?
        .to_logical::<f64>(scale);
    let window_number = window_number(&window)?;

    // 저장 위치는 앱 소유 디렉터리다. 공유 TMPDIR에 서브프로세스가 쓰면 실패할 수
    // 있다 — 2026-07-30 실측: "cannot write file to intended destination".
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("cache_dir_failed: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("cache_dir_create_failed: {e}"))?;
    let full = dir.join("design-mode-window.png");
    let cropped = dir.join("design-mode-element.png");

    let status = std::process::Command::new("/usr/sbin/screencapture")
        .args(["-x", "-o", "-l"])
        .arg(window_number.to_string())
        .arg(&full)
        .status()
        .map_err(|e| format!("screencapture_spawn_failed: {e}"))?;
    if !status.success() || !full.exists() {
        return Err(format!("screencapture_failed: status {status}"));
    }

    let (cx, cy, cw, ch) = crop_args(
        png_size(&full)?,
        (inner_size.width, inner_size.height),
        scale,
        (x, y, width, height),
    );
    let sips = std::process::Command::new("/usr/bin/sips")
        .args(["--cropOffset", &cy.to_string(), &cx.to_string()])
        .args(["--cropToHeightWidth", &ch.to_string(), &cw.to_string()])
        .arg(&full)
        .args(["--out"])
        .arg(&cropped)
        .output()
        .map_err(|e| format!("sips_spawn_failed: {e}"))?;
    if !sips.status.success() || !cropped.exists() {
        return Err(format!(
            "sips_crop_failed: {}",
            String::from_utf8_lossy(&sips.stderr).trim()
        ));
    }
    Ok(cropped.to_string_lossy().to_string())
}

/// 창을 닫는다. 없으면 조용히 성공 — 사용자가 이미 닫은 경우다.
#[tauri::command]
pub fn design_mode_close_browser<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(DESIGN_MODE_WINDOW_LABEL) {
        window
            .destroy()
            .map_err(|error| format!("destroy_failed: {error}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{join_chunks, parse_hash_chunk, percent_decode, validate_target};
    use std::collections::BTreeMap;

    #[test]
    fn parses_our_chunks_and_ignores_others() {
        let chunk = parse_hash_chunk("#dure-dm:n1:0:2:hello").expect("chunk");
        assert_eq!(chunk.nonce, "n1");
        assert_eq!(chunk.index, 0);
        assert_eq!(chunk.total, 2);
        assert_eq!(chunk.data, "hello");
        // 페이지가 쓰는 평범한 해시는 우리 것이 아니다.
        assert!(parse_hash_chunk("#section-2").is_none());
        assert!(parse_hash_chunk("#dure-dm:n1:0").is_none());
        // index가 total 밖이면 버린다.
        assert!(parse_hash_chunk("#dure-dm:n1:5:2:x").is_none());
    }

    #[test]
    fn chunk_data_may_contain_colons() {
        let chunk = parse_hash_chunk("dure-dm:n1:0:1:url%3A%20a%3Ab").expect("chunk");
        assert_eq!(chunk.data, "url%3A%20a%3Ab");
    }

    #[test]
    fn decodes_percent_escapes_including_utf8() {
        assert_eq!(percent_decode("a%20b").as_deref(), Some("a b"));
        assert_eq!(percent_decode("%ED%95%9C").as_deref(), Some("한"));
        // 잘못된 시퀀스는 버린다 — 부분 복원은 잘린 요청을 만든다.
        assert!(percent_decode("%ZZ").is_none());
        assert!(percent_decode("%A").is_none());
    }

    // 빠진 조각으로 복원하면 에이전트에게 잘린 요청이 간다.
    #[test]
    fn refuses_incomplete_chunk_sets() {
        let mut chunks = BTreeMap::new();
        chunks.insert(0, "a".to_string());
        assert!(join_chunks("n1", &chunks, 2).is_none());
        chunks.insert(1, "b".to_string());
        assert_eq!(join_chunks("n1", &chunks, 2).as_deref(), Some("ab"));
    }

    #[test]
    fn loopback_hosts_are_allowed() {
        for raw in [
            "http://localhost:3000",
            "http://127.0.0.1:5173/app",
            "https://localhost:8443",
            "http://app.localhost:3000",
        ] {
            assert!(validate_target(raw).is_ok(), "expected ok: {raw}");
        }
    }

    // 열기는 허용하되 **주입은 하지 않는다** — 주입이 없으면 픽커·nonce 표면도 없다.
    #[test]
    fn public_hosts_open_without_injection() {
        let url = validate_target("https://example.com").expect("opens");
        assert!(!super::is_loopback(&url));
        let local = validate_target("http://localhost:3000").expect("opens");
        assert!(super::is_loopback(&local));
    }

    #[test]
    fn non_http_schemes_are_refused() {
        assert!(validate_target("file:///etc/passwd")
            .unwrap_err()
            .starts_with("unsupported_scheme"));
        assert!(validate_target("javascript:alert(1)")
            .unwrap_err()
            .starts_with("unsupported_scheme"));
    }

    #[test]
    fn malformed_urls_are_refused() {
        assert!(validate_target("not a url")
            .unwrap_err()
            .starts_with("invalid_url"));
    }

    /// TS 인코더(`encodeHashChunks`)의 **실제 출력**이다. 두 언어의 규칙이 갈라지면
    /// 조용히 아무것도 도착하지 않으므로(조각을 못 모아 영원히 미완성) 여기서
    /// 고정한다. 갱신이 필요하면 그 인코더로 다시 생성할 것.
    #[test]
    fn decodes_real_multi_chunk_output_from_the_ts_encoder() {
        let raw = [
            "dure-dm:N:0:2:%7B%22type%22%3A%22dure%3Adesign-mode%3Acapture%3Av1%22%2C%22nonce%22%3A%22N%22%2C%22kind%22%3A%22pick%22%2C%22body%22%3A%7B%22captured%22%3A%7B%22label%22%3A%22button.save%20%E2%80%94%20%5C%22%EC%A0%80%EC%9E%A5%5C%22%22%2C%22html%22%3A%22%3Cbutton%20class%3D%5C%22a%5C%22%3E%EC%A0%80%EC%9E%A5%20%26%20%EC%B7%A8%EC%86%8C%3C%2Fbutton%3E%22%2C%22note%22%3A%22%EC%A4%84%EB%B0%94%EA%BF%88%5Cn%ED%8F%AC%ED%95%A8%22%2C%22pad%22%3A%22xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
            "dure-dm:N:1:2:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx%22%7D%7D%7D"
        ];
        let mut chunks = BTreeMap::new();
        let mut total = 0usize;
        for line in raw {
            let chunk = parse_hash_chunk(line).expect("chunk parses");
            assert_eq!(chunk.nonce, "N");
            total = chunk.total;
            chunks.insert(chunk.index, chunk.data);
        }
        assert_eq!(total, 2);
        let joined = join_chunks("N", &chunks, total).expect("joins");
        // 한글·따옴표·&·줄바꿈이 원문대로 복원돼야 한다.
        assert!(joined.contains("저장 & 취소"));
        // JSON 텍스트이므로 개행은 두 글자로 들어 있다 — raw 문자열로 비교한다.
        assert!(joined.contains(r"줄바꿈\n포함"));
        let value: serde_json::Value = serde_json::from_str(&joined).expect("valid json");
        assert_eq!(value["kind"], "pick");
        assert_eq!(value["nonce"], "N");
    }
}
