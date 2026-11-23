//! Streams the one video or PDF the presentation window shows.
//!
//! The window reads the presented file through `read_presented_file`. For a
//! video or PDF that read opens the file once (canonical, regular, read-only)
//! and returns an opaque token instead of the bytes; the `dure-media` route
//! then serves byte ranges from that open handle. There is one grant at a
//! time: the next read of any file, a reload of the window or its closing
//! revokes it. The route takes no path, so it cannot name another file, and it
//! answers only the presentation window's own requests.

use std::fs::File;
use std::os::unix::fs::FileExt;
use std::path::Path;
use std::sync::{Arc, Mutex};

use tauri::http::{header, Method, Request, Response, StatusCode};
use tauri::Manager;

use crate::files::{classify, read_local, FileContent};

/// Must match FILE_PRESENTATION_WINDOW_LABEL in the frontend's window module.
pub(crate) const PRESENTATION_WINDOW_LABEL: &str = "win-presentation";
/// Must match PRESENTED_MEDIA_SCHEME in the frontend.
pub(crate) const PRESENTED_MEDIA_SCHEME: &str = "dure-media";
/// One range response at most; media elements ask for the next range.
const RANGE_CHUNK_BYTES: u64 = 4 * 1024 * 1024;
/// A request without a Range header receives the whole file only up to this.
const WHOLE_RESPONSE_MAX_BYTES: u64 = 256 * 1024 * 1024;

struct Grant {
    token: String,
    file: File,
    mime: &'static str,
}

/// The single streamed file, if the presentation window currently shows one.
#[derive(Default)]
pub(crate) struct PresentedMedia {
    grant: Mutex<Option<Arc<Grant>>>,
}

impl PresentedMedia {
    fn replace(&self, grant: Option<Grant>) {
        *self
            .grant
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = grant.map(Arc::new);
    }

    pub(crate) fn revoke(&self) {
        self.replace(None);
    }

    fn current(&self, token: &str) -> Option<Arc<Grant>> {
        self.grant
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
            .filter(|grant| tokens_match(&grant.token, token))
            .cloned()
    }
}

fn tokens_match(expected: &str, candidate: &str) -> bool {
    expected.len() == candidate.len()
        && expected
            .bytes()
            .zip(candidate.bytes())
            .fold(0u8, |difference, (left, right)| difference | (left ^ right))
            == 0
}

fn is_streamed_kind(kind: &str) -> bool {
    kind == "video" || kind == "pdf"
}

/// What the presentation window shows: a streamed video/PDF opened once, or
/// any other file read inline by the shared file reader.
enum PresentedRead {
    Inline(FileContent),
    Streamed {
        content: FileContent,
        file: File,
        mime: &'static str,
    },
}

/// Normalizes the path at the boundary: absolute, canonical (symlinks and
/// `..` resolved), a regular file, opened read-only. Classification and the
/// inline read stay with `files`.
fn open_presented(path: &str) -> Result<PresentedRead, String> {
    let requested = Path::new(path);
    if !requested.is_absolute() {
        return Err(format!("{path}: an absolute file path is required"));
    }
    let name = requested
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or_else(|| format!("{path}: not a file path"))?;
    let (kind, mime) = classify(&name);
    let mime = match mime {
        Some(mime) if is_streamed_kind(kind) => mime,
        _ => return read_local(path).map(PresentedRead::Inline),
    };
    let canonical = std::fs::canonicalize(requested).map_err(|error| format!("{path}: {error}"))?;
    let file = File::open(&canonical).map_err(|error| format!("{path}: {error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("{path}: {error}"))?;
    if !metadata.is_file() {
        return Err(format!("{path}: not a regular file"));
    }
    Ok(PresentedRead::Streamed {
        content: FileContent {
            name,
            path: path.to_string(),
            kind: kind.to_string(),
            content: String::new(),
            size: metadata.len(),
            mime: Some(mime.to_string()),
            truncated: false,
            stream: None,
        },
        file,
        mime,
    })
}

fn present(state: &PresentedMedia, path: &str) -> Result<FileContent, String> {
    // Whatever the window shows next, the previous grant ends here.
    state.revoke();
    match open_presented(path)? {
        PresentedRead::Inline(content) => Ok(content),
        PresentedRead::Streamed {
            mut content,
            file,
            mime,
        } => {
            let token = crate::random_token::gen_token().map_err(|error| error.to_string())?;
            content.stream = Some(token.clone());
            state.replace(Some(Grant { token, file, mime }));
            Ok(content)
        }
    }
}

/// The presentation window's file read: videos and PDFs come back with a
/// stream token and no bytes; everything else is the ordinary inline read.
#[tauri::command(async)]
pub(crate) fn read_presented_file(
    webview: tauri::Webview,
    state: tauri::State<'_, PresentedMedia>,
    path: String,
) -> Result<FileContent, String> {
    if webview.label() != PRESENTATION_WINDOW_LABEL {
        return Err("Only the presentation window reads presented files".into());
    }
    present(&state, &path)
}

#[derive(Debug, PartialEq, Eq)]
enum RangeRequest {
    /// No usable Range header: answer with the whole file.
    Whole,
    /// Inclusive byte offsets, already within the file.
    Partial {
        start: u64,
        end: u64,
    },
    Unsatisfiable,
}

/// One `bytes=` range. Multiple ranges or malformed headers are ignored, as
/// RFC 9110 allows, and answered with the whole file.
fn parse_range(header: Option<&str>, len: u64) -> RangeRequest {
    let Some(spec) = header.and_then(|value| value.trim().strip_prefix("bytes=")) else {
        return RangeRequest::Whole;
    };
    if spec.contains(',') {
        return RangeRequest::Whole;
    }
    let Some((first, last)) = spec.trim().split_once('-') else {
        return RangeRequest::Whole;
    };
    let number = |value: &str| -> Option<u64> {
        let value = value.trim();
        (!value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
            .then(|| value.parse().ok())
            .flatten()
    };
    let (start, end) = match (first.trim().is_empty(), number(first), number(last)) {
        // bytes=-N: the last N bytes.
        (true, _, Some(suffix)) => {
            if suffix == 0 || len == 0 {
                return RangeRequest::Unsatisfiable;
            }
            (len.saturating_sub(suffix), len - 1)
        }
        (false, Some(start), None) if last.trim().is_empty() => (start, len.saturating_sub(1)),
        (false, Some(start), Some(end)) if end >= start => (start, end.min(len.saturating_sub(1))),
        _ => return RangeRequest::Whole,
    };
    if start >= len {
        return RangeRequest::Unsatisfiable;
    }
    RangeRequest::Partial { start, end }
}

fn read_exact_at(file: &File, offset: u64, len: u64) -> std::io::Result<Vec<u8>> {
    let mut buffer = vec![0; usize::try_from(len).map_err(std::io::Error::other)?];
    file.read_exact_at(&mut buffer, offset)?;
    Ok(buffer)
}

fn empty(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, "no-store")
        .body(Vec::new())
        .expect("static response headers are valid")
}

/// Answers one route request. Only the presentation window, a GET or HEAD,
/// and the current grant's exact token are served; anything else is 404 so
/// the route reveals nothing about other files or earlier grants.
fn respond(
    state: &PresentedMedia,
    webview_label: &str,
    request: &Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let method = request.method();
    if *method != Method::GET && *method != Method::HEAD {
        return empty(StatusCode::METHOD_NOT_ALLOWED);
    }
    let token = request.uri().path().trim_start_matches('/');
    let grant = match (
        webview_label == PRESENTATION_WINDOW_LABEL,
        state.current(token),
    ) {
        (true, Some(grant)) => grant,
        _ => return empty(StatusCode::NOT_FOUND),
    };
    let len = match grant.file.metadata() {
        Ok(metadata) => metadata.len(),
        Err(_) => return empty(StatusCode::NOT_FOUND),
    };
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok());
    let response = Response::builder()
        .header(header::CONTENT_TYPE, grant.mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff");
    let (response, start, length) = match parse_range(range, len) {
        RangeRequest::Unsatisfiable => {
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{len}"))
                .header(header::CACHE_CONTROL, "no-store")
                .body(Vec::new())
                .expect("range response headers are valid");
        }
        RangeRequest::Partial { start, end } => {
            let end = end.min(start.saturating_add(RANGE_CHUNK_BYTES - 1));
            (
                response
                    .status(StatusCode::PARTIAL_CONTENT)
                    .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}")),
                start,
                end - start + 1,
            )
        }
        RangeRequest::Whole if len > WHOLE_RESPONSE_MAX_BYTES => {
            return empty(StatusCode::PAYLOAD_TOO_LARGE);
        }
        RangeRequest::Whole => (response.status(StatusCode::OK), 0, len),
    };
    let response = response.header(header::CONTENT_LENGTH, length);
    let body = if *method == Method::HEAD {
        Vec::new()
    } else {
        match read_exact_at(&grant.file, start, length) {
            Ok(body) => body,
            Err(_) => return empty(StatusCode::INTERNAL_SERVER_ERROR),
        }
    };
    response
        .body(body)
        .expect("media response headers are valid")
}

/// Registers the grant state, the read-only route and the grant's end when the
/// presentation window reloads or closes.
pub(crate) fn configure(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder
        .manage(PresentedMedia::default())
        .register_asynchronous_uri_scheme_protocol(
            PRESENTED_MEDIA_SCHEME,
            |context, request, responder| {
                let app = context.app_handle().clone();
                let label = context.webview_label().to_string();
                tauri::async_runtime::spawn_blocking(move || {
                    responder.respond(respond(&app.state::<PresentedMedia>(), &label, &request));
                });
            },
        )
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("presented-media")
                .on_page_load(|webview, payload| {
                    if webview.label() == PRESENTATION_WINDOW_LABEL
                        && matches!(payload.event(), tauri::webview::PageLoadEvent::Started)
                    {
                        webview.state::<PresentedMedia>().revoke();
                    }
                })
                .build(),
        )
        .on_window_event(|window, event| {
            if window.label() == PRESENTATION_WINDOW_LABEL
                && matches!(event, tauri::WindowEvent::Destroyed)
            {
                window.state::<PresentedMedia>().revoke();
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn fixture(name: &str, bytes: &[u8]) -> (tempfile::TempDir, String) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(name);
        std::fs::File::create(&path)
            .unwrap()
            .write_all(bytes)
            .unwrap();
        let path = path.to_string_lossy().into_owned();
        (directory, path)
    }

    fn request(method: Method, token: &str, range: Option<&str>) -> Request<Vec<u8>> {
        let mut builder = Request::builder()
            .method(method)
            .uri(format!("dure-media://localhost/{token}"));
        if let Some(range) = range {
            builder = builder.header(header::RANGE, range);
        }
        builder.body(Vec::new()).unwrap()
    }

    fn header_text(response: &Response<Vec<u8>>, name: header::HeaderName) -> Option<&str> {
        response
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
    }

    #[test]
    fn parses_single_byte_ranges_and_ignores_the_rest() {
        assert_eq!(parse_range(None, 100), RangeRequest::Whole);
        assert_eq!(
            parse_range(Some("bytes=0-1"), 100),
            RangeRequest::Partial { start: 0, end: 1 }
        );
        assert_eq!(
            parse_range(Some("bytes=10-"), 100),
            RangeRequest::Partial { start: 10, end: 99 }
        );
        assert_eq!(
            parse_range(Some("bytes=90-500"), 100),
            RangeRequest::Partial { start: 90, end: 99 }
        );
        assert_eq!(
            parse_range(Some("bytes=-30"), 100),
            RangeRequest::Partial { start: 70, end: 99 }
        );
        assert_eq!(
            parse_range(Some("bytes=-300"), 100),
            RangeRequest::Partial { start: 0, end: 99 }
        );
        assert_eq!(
            parse_range(Some("bytes=100-"), 100),
            RangeRequest::Unsatisfiable
        );
        assert_eq!(
            parse_range(Some("bytes=-0"), 100),
            RangeRequest::Unsatisfiable
        );
        assert_eq!(
            parse_range(Some("bytes=0-"), 0),
            RangeRequest::Unsatisfiable
        );
        for ignored in [
            "items=0-1",
            "bytes=5-2",
            "bytes=a-b",
            "bytes=0-1,4-5",
            "bytes=+1-2",
            "bytes=-",
        ] {
            assert_eq!(
                parse_range(Some(ignored), 100),
                RangeRequest::Whole,
                "{ignored}"
            );
        }
    }

    #[test]
    fn streams_a_presented_video_by_range_from_the_opened_file() {
        let bytes: Vec<u8> = (0..=255u8).cycle().take(10_000).collect();
        let (_directory, path) = fixture("screen recording.mp4", &bytes);
        let state = PresentedMedia::default();
        let content = present(&state, &path).unwrap();
        assert_eq!(
            (
                content.kind.as_str(),
                content.size,
                content.content.as_str()
            ),
            ("video", 10_000, "")
        );
        assert_eq!(content.mime.as_deref(), Some("video/mp4"));
        assert!(!content.truncated);
        let token = content.stream.unwrap();

        let partial = respond(
            &state,
            PRESENTATION_WINDOW_LABEL,
            &request(Method::GET, &token, Some("bytes=100-199")),
        );
        assert_eq!(partial.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            header_text(&partial, header::CONTENT_RANGE),
            Some("bytes 100-199/10000")
        );
        assert_eq!(header_text(&partial, header::CONTENT_LENGTH), Some("100"));
        assert_eq!(
            header_text(&partial, header::CONTENT_TYPE),
            Some("video/mp4")
        );
        assert_eq!(header_text(&partial, header::ACCEPT_RANGES), Some("bytes"));
        assert_eq!(partial.body().as_slice(), &bytes[100..200]);

        let whole = respond(
            &state,
            PRESENTATION_WINDOW_LABEL,
            &request(Method::GET, &token, None),
        );
        assert_eq!(whole.status(), StatusCode::OK);
        assert_eq!(whole.body(), &bytes);

        let head = respond(
            &state,
            PRESENTATION_WINDOW_LABEL,
            &request(Method::HEAD, &token, Some("bytes=0-1")),
        );
        assert_eq!(head.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(header_text(&head, header::CONTENT_LENGTH), Some("2"));
        assert!(head.body().is_empty());

        let beyond = respond(
            &state,
            PRESENTATION_WINDOW_LABEL,
            &request(Method::GET, &token, Some("bytes=10000-")),
        );
        assert_eq!(beyond.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(
            header_text(&beyond, header::CONTENT_RANGE),
            Some("bytes */10000")
        );
    }

    #[test]
    fn caps_each_range_response_and_has_no_whole_file_ceiling_for_ranges() {
        let file = tempfile::tempfile().unwrap();
        // A sparse file larger than the old 25 MB inline cap and the whole-response ceiling.
        let len = WHOLE_RESPONSE_MAX_BYTES + 64 * 1024 * 1024;
        file.set_len(len).unwrap();
        file.write_all_at(b"tail", len - 4).unwrap();
        let state = PresentedMedia::default();
        state.replace(Some(Grant {
            token: "t".repeat(32),
            file,
            mime: "video/webm",
        }));
        let token = "t".repeat(32);

        let first = respond(
            &state,
            PRESENTATION_WINDOW_LABEL,
            &request(Method::GET, &token, Some("bytes=0-")),
        );
        assert_eq!(first.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(first.body().len() as u64, RANGE_CHUNK_BYTES);
        assert_eq!(
            header_text(&first, header::CONTENT_RANGE),
            Some(format!("bytes 0-{}/{len}", RANGE_CHUNK_BYTES - 1).as_str())
        );
        let last = respond(
            &state,
            PRESENTATION_WINDOW_LABEL,
            &request(Method::GET, &token, Some("bytes=-4")),
        );
        assert_eq!(last.body().as_slice(), b"tail");
        let whole = respond(
            &state,
            PRESENTATION_WINDOW_LABEL,
            &request(Method::GET, &token, None),
        );
        assert_eq!(whole.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[test]
    fn serves_only_the_current_grant_to_the_presentation_window() {
        let (_video_directory, video) = fixture("demo.webm", b"video bytes");
        let (_pdf_directory, pdf) = fixture("report.pdf", b"%PDF-1.4 report");
        let (_notes_directory, notes) = fixture("notes.md", b"# Notes");
        let state = PresentedMedia::default();
        let first = present(&state, &video).unwrap().stream.unwrap();
        let ok = |token: &str| {
            respond(
                &state,
                PRESENTATION_WINDOW_LABEL,
                &request(Method::GET, token, None),
            )
            .status()
        };

        assert_eq!(ok(&first), StatusCode::OK);
        assert_eq!(
            respond(&state, "main", &request(Method::GET, &first, None)).status(),
            StatusCode::NOT_FOUND,
            "another window cannot use the token"
        );
        assert_eq!(ok("../../etc/passwd"), StatusCode::NOT_FOUND);
        assert_eq!(ok(&video), StatusCode::NOT_FOUND, "the route takes no path");
        assert_eq!(
            respond(
                &state,
                PRESENTATION_WINDOW_LABEL,
                &request(Method::POST, &first, None)
            )
            .status(),
            StatusCode::METHOD_NOT_ALLOWED
        );

        // Presenting another file revokes the previous token.
        let second = present(&state, &pdf).unwrap().stream.unwrap();
        assert_ne!(first, second);
        assert_eq!(ok(&first), StatusCode::NOT_FOUND);
        let pdf_response = respond(
            &state,
            PRESENTATION_WINDOW_LABEL,
            &request(Method::GET, &second, None),
        );
        assert_eq!(
            header_text(&pdf_response, header::CONTENT_TYPE),
            Some("application/pdf")
        );
        assert_eq!(pdf_response.body().as_slice(), b"%PDF-1.4 report");

        // An inline file revokes too, and keeps the ordinary read.
        let inline = present(&state, &notes).unwrap();
        assert_eq!(
            (inline.kind.as_str(), inline.content.as_str(), inline.stream),
            ("markdown", "# Notes", None)
        );
        assert_eq!(ok(&second), StatusCode::NOT_FOUND);

        let third = present(&state, &video).unwrap().stream.unwrap();
        state.revoke();
        assert_eq!(ok(&third), StatusCode::NOT_FOUND);
    }

    #[test]
    fn keeps_streaming_the_presented_file_when_its_path_is_replaced() {
        let (directory, path) = fixture("clip.mp4", b"original");
        let state = PresentedMedia::default();
        let token = present(&state, &path).unwrap().stream.unwrap();
        let replacement = directory.path().join("other.mp4");
        std::fs::write(&replacement, b"replaced").unwrap();
        std::fs::rename(&replacement, &path).unwrap();
        let response = respond(
            &state,
            PRESENTATION_WINDOW_LABEL,
            &request(Method::GET, &token, None),
        );
        assert_eq!(response.body().as_slice(), b"original");
    }

    #[test]
    fn normalizes_the_presented_path_at_the_boundary() {
        let (directory, path) = fixture("clip.mp4", b"bytes");
        let state = PresentedMedia::default();
        assert!(present(&state, "clip.mp4")
            .err()
            .is_some_and(|error| error.contains("absolute")));
        let traversed = directory.path().join("sub/../clip.mp4");
        std::fs::create_dir(directory.path().join("sub")).unwrap();
        let content = present(&state, &traversed.to_string_lossy()).unwrap();
        assert_eq!(content.size, 5);
        std::fs::create_dir(directory.path().join("folder.mp4")).unwrap();
        assert!(present(
            &state,
            &directory.path().join("folder.mp4").to_string_lossy()
        )
        .is_err());
        assert!(present(
            &state,
            &directory.path().join("missing.pdf").to_string_lossy()
        )
        .is_err());
        let link = directory.path().join("link.webm");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        let token = present(&state, &link.to_string_lossy())
            .unwrap()
            .stream
            .unwrap();
        let response = respond(
            &state,
            PRESENTATION_WINDOW_LABEL,
            &request(Method::GET, &token, None),
        );
        assert_eq!(response.body().as_slice(), b"bytes");
    }
}
