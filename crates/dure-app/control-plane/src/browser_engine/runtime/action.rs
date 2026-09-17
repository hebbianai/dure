use super::find::FindAction;
use super::locator::BrowserLocator;
use super::wait::BrowserFunctionWait;
use hmux_session_protocol::browser_resource::{BrowserElementReference, BrowserPageLabel};
use serde::Deserialize;
use serde_json::{Value, json};

/// Parse selectors once; an engine-local @eN must carry its Host snapshot.
#[derive(Clone, Debug, Deserialize)]
#[serde(try_from = "RawTarget")]
pub struct BrowserElementTarget(Target);

#[derive(Clone, Debug)]
enum Target {
    Css(String),
    Reference {
        reference: BrowserElementReference,
        backend: i64,
    },
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum RawTarget {
    Css { selector: String },
    Reference { reference: BrowserElementReference },
}

impl TryFrom<RawTarget> for BrowserElementTarget {
    type Error = &'static str;
    fn try_from(value: RawTarget) -> Result<Self, Self::Error> {
        Ok(Self(match value {
            RawTarget::Css { selector } => {
                let trimmed = selector.trim();
                let bare_ref = trimmed.strip_prefix('e').is_some_and(|digits| {
                    !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
                });
                if trimmed.is_empty()
                    || selector.len() > 8192
                    || trimmed.starts_with('@')
                    || trimmed.starts_with("ref=")
                    || bare_ref
                {
                    return Err("browser_selector_invalid");
                }
                Target::Css(selector)
            }
            RawTarget::Reference { reference } => {
                let element = reference.element.as_str();
                let digits = element.strip_prefix('e').ok_or("browser_element_invalid")?;
                if digits.is_empty()
                    || digits.starts_with('0')
                    || !digits.bytes().all(|byte| byte.is_ascii_digit())
                {
                    return Err("browser_element_invalid");
                }
                let backend = digits
                    .parse::<i64>()
                    .map_err(|_| "browser_element_invalid")?;
                Target::Reference { reference, backend }
            }
        }))
    }
}

impl BrowserElementTarget {
    pub(super) async fn resolve(
        &self,
        cdp: super::BrowserCdp,
        target: &str,
    ) -> Result<super::locator::LocatedElement, &'static str> {
        match &self.0 {
            Target::Css(selector) => {
                super::locator::LocatedElement::resolve(
                    cdp,
                    target,
                    &BrowserLocator::first(selector),
                )
                .await
            }
            Target::Reference { backend, .. } => {
                super::locator::LocatedElement::resolve_node(cdp, target, *backend).await
            }
        }
    }
    pub(super) fn selector(&self) -> Result<&str, &'static str> {
        match &self.0 {
            Target::Css(selector) => Ok(selector),
            Target::Reference { .. } => Err("browser_reference_requires_bound_node"),
        }
    }

    pub(super) fn reference(&self) -> Option<&BrowserElementReference> {
        match &self.0 {
            Target::Reference { reference, .. } => Some(reference),
            Target::Css(_) => None,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(try_from = "Action")]
pub struct BrowserAction(Action);

/// Navigation and profile page creation admit the same bounded URL grammar.
#[derive(Debug, Deserialize)]
#[serde(try_from = "String")]
pub(crate) struct BrowserPageUrl(String);

impl TryFrom<String> for BrowserPageUrl {
    type Error = &'static str;

    fn try_from(url: String) -> Result<Self, Self::Error> {
        if url.len() > 8192
            || !(url.starts_with("http://") || url.starts_with("https://") || url == "about:blank")
        {
            return Err("browser_url_invalid");
        }
        Ok(Self(url))
    }
}

impl BrowserPageUrl {
    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Action {
    Tracing {
        action: super::tracing::TracingAction,
    },
    Disconnect,
    Frame {
        target: BrowserElementTarget,
    },
    MainFrame,
    Interception {
        action: hmux_session_protocol::browser_interception::BrowserInterceptionAction,
    },
    NetworkCapture {
        action: super::har::NetworkCaptureAction,
    },
    Record {
        action: super::recording::RecordingAction,
        format: Option<super::recording::RecordingFormat>,
    },
    ConsoleClear {
        #[serde(default)]
        entry_kind: Option<hmux_session_protocol::browser_console::BrowserConsoleKind>,
    },
    NetworkClear,
    Mouse {
        action: hmux_session_protocol::browser_pointer::BrowserPointerAction,
    },
    Environment {
        action: super::environment::BrowserEnvironmentAction,
    },
    Data {
        action: super::data::BrowserDataAction,
    },
    Download {
        target: BrowserElementTarget,
        #[serde(default = "super::download::default_timeout")]
        timeout_ms: u32,
    },
    Upload {
        target: BrowserElementTarget,
        files: Vec<super::BrowserUploadId>,
    },
    PrintPdf,
    StateSave {
        encryption_key: Option<super::state::BrowserStateKey>,
    },
    StateLoad {
        file: super::BrowserUploadId,
        encryption_key: Option<super::state::BrowserStateKey>,
    },
    Find {
        locator: BrowserLocator,
        action: FindAction,
    },
    Vitals {
        url: Option<BrowserPageUrl>,
    },
    React {
        action: super::react::ReactAction,
    },
    Navigate {
        url: BrowserPageUrl,
    },
    InitScript {
        action: super::init_script::BrowserInitScriptAction,
    },
    PushState {
        url: String,
    },
    Back,
    Forward,
    Reload,
    Tap {
        target: BrowserElementTarget,
    },
    Swipe {
        direction: ScrollDirection,
        distance: u32,
    },
    Click {
        target: BrowserElementTarget,
    },
    DoubleClick {
        target: BrowserElementTarget,
    },
    Select {
        target: BrowserElementTarget,
        values: Vec<String>,
    },
    Check {
        target: BrowserElementTarget,
    },
    Uncheck {
        target: BrowserElementTarget,
    },
    Focus {
        target: BrowserElementTarget,
    },
    SelectAll {
        target: BrowserElementTarget,
    },
    Hover {
        target: BrowserElementTarget,
    },
    Highlight {
        target: BrowserElementTarget,
    },
    ScrollIntoView {
        target: BrowserElementTarget,
    },
    Scroll {
        direction: ScrollDirection,
        amount: u32,
    },
    Drag {
        source: BrowserElementTarget,
        target: BrowserElementTarget,
    },
    Fill {
        target: BrowserElementTarget,
        text: String,
    },
    InsertText {
        text: String,
    },
    TypeText {
        text: String,
    },
    Press {
        key: hmux_session_protocol::browser_keyboard::BrowserKeyChord,
    },
    Clipboard {
        operation: super::keyboard::ClipboardOperation,
    },
    KeyDown {
        key: hmux_session_protocol::browser_keyboard::BrowserKey,
    },
    KeyUp {
        key: hmux_session_protocol::browser_keyboard::BrowserKey,
    },
    Evaluate {
        script: String,
    },
    WaitFunction {
        wait: BrowserFunctionWait,
    },
    NewPage {
        url: BrowserPageUrl,
        label: Option<BrowserPageLabel>,
    },
    NewWindow {},
    SelectPage,
    ClosePage,
}

#[derive(Debug, Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
enum ScrollDirection {
    Up,
    Down,
    Left,
    Right,
}

impl TryFrom<Action> for BrowserAction {
    type Error = &'static str;
    fn try_from(value: Action) -> Result<Self, Self::Error> {
        match &value {
            Action::Record {
                action: super::recording::RecordingAction::Start,
                format: Some(_),
            } => {
                return Err("browser_recording_format_requires_stop");
            }
            Action::Download { timeout_ms, .. } if !(1..=30_000).contains(timeout_ms) => {
                return Err("browser_download_timeout_invalid");
            }
            Action::Upload { files, .. }
                if files.is_empty() || files.len() > super::upload::MAX_FILES =>
            {
                return Err("browser_upload_files_invalid");
            }
            Action::Find { action, .. } => action.validate()?,
            Action::InitScript { action } => action.validate()?,
            Action::PushState { url } if url.len() > 8192 => {
                return Err("browser_history_url_too_large");
            }
            Action::Select { values, .. }
                if values.is_empty()
                    || values.len() > 128
                    || values.iter().map(String::len).sum::<usize>() > 64 * 1024 =>
            {
                return Err("browser_selection_invalid");
            }
            Action::Swipe {
                direction,
                distance,
            } => {
                let limit = match direction {
                    ScrollDirection::Right => 999_800,
                    ScrollDirection::Down => 999_600,
                    ScrollDirection::Up | ScrollDirection::Left => 1_000_000,
                };
                if *distance > limit {
                    return Err("browser_swipe_invalid");
                }
            }
            Action::Scroll { amount, .. } if *amount > 1_000_000 => {
                return Err("browser_scroll_invalid");
            }
            Action::Drag { source, target } => {
                if let (Some(source), Some(target)) = (source.reference(), target.reference()) {
                    if source.snapshot != target.snapshot {
                        return Err("browser_drag_snapshot_mismatch");
                    }
                }
            }
            Action::Fill { text, .. } | Action::InsertText { text } | Action::TypeText { text }
                if text.len() > 64 * 1024 =>
            {
                return Err("browser_text_too_large");
            }
            Action::Evaluate { script } if script.len() > 64 * 1024 => {
                return Err("browser_script_too_large");
            }
            _ => {}
        }
        Ok(Self(value))
    }
}

impl BrowserAction {
    pub(super) fn swipe(&self) -> Option<(&'static str, f64, f64)> {
        let Action::Swipe {
            direction,
            distance,
        } = &self.0
        else {
            return None;
        };
        let distance = f64::from(*distance);
        Some(match direction {
            ScrollDirection::Up => ("up", 0.0, -distance),
            ScrollDirection::Down => ("down", 0.0, distance),
            ScrollDirection::Left => ("left", -distance, 0.0),
            ScrollDirection::Right => ("right", distance, 0.0),
        })
    }

    pub(super) fn disconnects_worker(&self) -> bool {
        matches!(self.0, Action::Disconnect)
    }
    pub(super) fn frame_selection(&self) -> Option<Option<&BrowserElementTarget>> {
        match &self.0 {
            Action::Frame { target } => Some(Some(target)),
            Action::MainFrame => Some(None),
            _ => None,
        }
    }

    pub(super) fn uses_document(&self) -> bool {
        self.element_action().is_some()
            || self.find().is_some()
            || self.drag().is_some()
            || self.evaluation_script().is_some()
            || self.push_state_url().is_some()
            || self.scroll_offset().is_some()
            || self.upload().is_some()
            || self.download().is_some()
            || self.data().is_some()
    }
    pub(super) fn selects_page(&self) -> bool {
        matches!(self.0, Action::SelectPage)
    }

    pub(super) fn network_capture(&self) -> Option<&super::har::NetworkCaptureAction> {
        match &self.0 {
            Action::NetworkCapture { action } => Some(action),
            _ => None,
        }
    }
    pub(super) fn tracing(&self) -> Option<&super::tracing::TracingAction> {
        match &self.0 {
            Action::Tracing { action } => Some(action),
            _ => None,
        }
    }

    pub(super) fn recording(
        &self,
    ) -> Option<(
        super::recording::RecordingAction,
        super::recording::RecordingFormat,
    )> {
        match self.0 {
            Action::Record { action, format } => Some((action, format.unwrap_or_default())),
            _ => None,
        }
    }
    pub(super) fn console_clear(
        &self,
    ) -> Option<Option<hmux_session_protocol::browser_console::BrowserConsoleKind>> {
        match self.0 {
            Action::ConsoleClear { entry_kind } => Some(entry_kind),
            _ => None,
        }
    }

    pub(super) fn is_network_clear(&self) -> bool {
        matches!(self.0, Action::NetworkClear)
    }
    pub(super) fn history(&self) -> Option<super::pages::history::HistoryAction> {
        use super::pages::history::HistoryAction;
        match self.0 {
            Action::Back => Some(HistoryAction::Back),
            Action::Forward => Some(HistoryAction::Forward),
            Action::Reload => Some(HistoryAction::Reload),
            _ => None,
        }
    }

    pub(super) fn vitals(&self) -> Option<Option<&str>> {
        match &self.0 {
            Action::Vitals { url } => Some(url.as_ref().map(BrowserPageUrl::as_str)),
            _ => None,
        }
    }

    pub(super) fn react(&self) -> Option<&super::react::ReactAction> {
        match &self.0 {
            Action::React { action } => Some(action),
            _ => None,
        }
    }

    pub(super) fn init_script(&self) -> Option<&super::init_script::BrowserInitScriptAction> {
        match &self.0 {
            Action::InitScript { action } => Some(action),
            _ => None,
        }
    }

    pub(super) fn push_state_url(&self) -> Option<&str> {
        match &self.0 {
            Action::PushState { url } => Some(url),
            _ => None,
        }
    }

    pub(super) fn scroll_offset(&self) -> Option<(i64, i64)> {
        let Action::Scroll { direction, amount } = &self.0 else {
            return None;
        };
        let amount = i64::from(*amount);
        Some(match direction {
            ScrollDirection::Up => (0, -amount),
            ScrollDirection::Down => (0, amount),
            ScrollDirection::Left => (-amount, 0),
            ScrollDirection::Right => (amount, 0),
        })
    }
    pub(super) fn keyboard(&self) -> Option<super::keyboard::KeyboardAction<'_>> {
        use super::keyboard::KeyboardAction;
        match &self.0 {
            Action::Press { key } => Some(KeyboardAction::Press(key)),
            Action::Clipboard { operation } => Some(KeyboardAction::Clipboard(*operation)),
            Action::KeyDown { key } => Some(KeyboardAction::Down(key)),
            Action::KeyUp { key } => Some(KeyboardAction::Up(key)),
            _ => None,
        }
    }
    pub(super) fn mouse(
        &self,
    ) -> Option<hmux_session_protocol::browser_pointer::BrowserPointerAction> {
        match &self.0 {
            Action::Mouse { action } => Some(*action),
            _ => None,
        }
    }
    pub(super) fn insertion_text(&self) -> Option<&str> {
        match &self.0 {
            Action::InsertText { text } => Some(text),
            _ => None,
        }
    }
    pub(super) fn typing_text(&self) -> Option<&str> {
        match &self.0 {
            Action::TypeText { text } => Some(text),
            _ => None,
        }
    }
    pub(super) fn evaluation_script(&self) -> Option<&str> {
        match &self.0 {
            Action::Evaluate { script } => Some(script),
            _ => None,
        }
    }

    pub(super) fn interception(
        &self,
    ) -> Option<&hmux_session_protocol::browser_interception::BrowserInterceptionAction> {
        match &self.0 {
            Action::Interception { action } => Some(action),
            _ => None,
        }
    }
    pub(super) fn environment(&self) -> Option<&super::environment::BrowserEnvironmentAction> {
        match &self.0 {
            Action::Environment { action } => Some(action),
            _ => None,
        }
    }
    pub(super) fn data(&self) -> Option<&super::data::BrowserDataAction> {
        match &self.0 {
            Action::Data { action } => Some(action),
            _ => None,
        }
    }
    pub(super) fn download(&self) -> Option<(&BrowserElementTarget, u32)> {
        match &self.0 {
            Action::Download { target, timeout_ms } => Some((target, *timeout_ms)),
            _ => None,
        }
    }
    pub(super) fn upload(&self) -> Option<(&BrowserElementTarget, &[super::BrowserUploadId])> {
        match &self.0 {
            Action::Upload { target, files } => Some((target, files)),
            _ => None,
        }
    }
    pub(super) fn element_action(&self) -> Option<(&BrowserElementTarget, FindAction)> {
        Some(match &self.0 {
            Action::Tap { target } => (target, FindAction::Tap),
            Action::Click { target } => (target, FindAction::Click),
            Action::DoubleClick { target } => (target, FindAction::DoubleClick),
            Action::Check { target } => (target, FindAction::Check),
            Action::Uncheck { target } => (target, FindAction::Uncheck),
            Action::Focus { target } => (target, FindAction::Focus),
            Action::SelectAll { target } => (target, FindAction::SelectAll),
            Action::Hover { target } => (target, FindAction::Hover),
            Action::Highlight { target } => (target, FindAction::Highlight),
            Action::ScrollIntoView { target } => (target, FindAction::ScrollIntoView),
            Action::Select { target, values } => (
                target,
                FindAction::Select {
                    values: values.clone(),
                },
            ),
            Action::Fill { target, text } => (target, FindAction::Fill { text: text.clone() }),
            _ => return None,
        })
    }
    pub(super) fn drag(&self) -> Option<(&BrowserElementTarget, &BrowserElementTarget)> {
        if let Action::Drag { source, target } = &self.0 {
            Some((source, target))
        } else {
            None
        }
    }
    pub(super) fn is_pdf(&self) -> bool {
        matches!(self.0, Action::PrintPdf)
    }
    pub(super) fn state_save(&self) -> Option<Option<&super::state::BrowserStateKey>> {
        match &self.0 {
            Action::StateSave { encryption_key } => Some(encryption_key.as_ref()),
            _ => None,
        }
    }

    pub(super) fn state_load(
        &self,
    ) -> Option<(
        &super::BrowserUploadId,
        Option<&super::state::BrowserStateKey>,
    )> {
        match &self.0 {
            Action::StateLoad {
                file,
                encryption_key,
            } => Some((file, encryption_key.as_ref())),
            _ => None,
        }
    }
    pub(super) fn find(&self) -> Option<(&BrowserLocator, &FindAction)> {
        match &self.0 {
            Action::Find { locator, action } => Some((locator, action)),
            _ => None,
        }
    }
    pub(super) fn new_page(&self) -> Option<(&str, super::events::PageCreationContext)> {
        match &self.0 {
            Action::NewPage { url, .. } => {
                Some((url.as_str(), super::events::PageCreationContext::Default))
            }
            Action::NewWindow {} => {
                Some(("about:blank", super::events::PageCreationContext::Isolated))
            }
            _ => None,
        }
    }

    pub(super) fn new_page_label(&self) -> Option<&BrowserPageLabel> {
        match &self.0 {
            Action::NewPage { label, .. } => label.as_ref(),
            _ => None,
        }
    }

    pub(super) fn navigation_url(&self) -> Option<&str> {
        match &self.0 {
            Action::Navigate { url } => Some(url.as_str()),
            _ => None,
        }
    }

    pub(super) fn function_wait(&self) -> Option<&BrowserFunctionWait> {
        match &self.0 {
            Action::WaitFunction { wait } => Some(wait),
            _ => None,
        }
    }

    pub(super) fn references(&self) -> impl Iterator<Item = &BrowserElementReference> {
        match &self.0 {
            Action::Tap { target }
            | Action::Click { target }
            | Action::Frame { target }
            | Action::Download { target, .. }
            | Action::Upload { target, .. }
            | Action::DoubleClick { target }
            | Action::Select { target, .. }
            | Action::Check { target }
            | Action::Uncheck { target }
            | Action::Focus { target }
            | Action::SelectAll { target }
            | Action::Hover { target }
            | Action::Highlight { target }
            | Action::ScrollIntoView { target }
            | Action::Fill { target, .. } => [target.reference(), None],
            Action::Drag { source, target } => [source.reference(), target.reference()],
            _ => [None, None],
        }
        .into_iter()
        .flatten()
    }

    pub(super) fn replaces_elements(&self) -> bool {
        matches!(
            self.0,
            Action::Navigate { .. }
                | Action::Vitals { .. }
                | Action::StateLoad { .. }
                | Action::Back
                | Action::Forward
                | Action::Reload
                | Action::NewPage { .. }
                | Action::NewWindow {}
                | Action::ClosePage
        )
    }

    pub(super) fn commands(&self) -> Vec<Value> {
        match &self.0 {
            Action::Disconnect => unreachable!("the instance owns worker disconnection"),
            Action::Frame { .. } | Action::MainFrame => unreachable!("Host owns frame selection"),
            Action::Interception { .. } => unreachable!("Host owns request routing"),
            Action::NetworkCapture { .. } => unreachable!("Host owns the recording interval"),
            Action::Record { .. } => unreachable!("Host owns the recording transition"),
            Action::Tracing { .. } => unreachable!("the instance Host owns tracing"),
            Action::ConsoleClear { .. } => unreachable!("Host owns console history"),
            Action::NetworkClear => unreachable!("Host owns network history"),
            Action::Mouse { .. } => unreachable!("Host owns all pointer state"),
            Action::Swipe { .. } => unreachable!("Host owns the touch contact"),
            Action::Environment { .. } => {
                unreachable!("emulation retains its admitted target session")
            }
            Action::Data { .. } => unreachable!("browser data uses the admitted Chromium target"),
            Action::Download { .. } => unreachable!("downloads use an admitted bound-node click"),
            Action::Upload { .. } => unreachable!("uploads use sealed resource files"),
            Action::PrintPdf => unreachable!("PDF printing uses an admitted stream"),
            Action::StateSave { .. } | Action::StateLoad { .. } => {
                unreachable!("state restores use sealed files and acknowledged documents")
            }
            Action::Find { .. } => unreachable!("semantic actions bind their exact node"),
            Action::Vitals { .. } => unreachable!("measurements retain their committed document"),
            Action::React { .. } => unreachable!("React inspection uses the admitted Page session"),
            Action::Navigate { .. } => unreachable!("navigation follows the Host renderer clock"),
            Action::InitScript { .. } => {
                unreachable!("initialization scripts use the admitted Page session")
            }
            Action::PushState { .. } => {
                unreachable!("history scripts follow the Host renderer clock")
            }
            Action::Back | Action::Forward | Action::Reload => {
                unreachable!("history consumes retained Page completions")
            }
            Action::Tap { .. }
            | Action::Click { .. }
            | Action::DoubleClick { .. }
            | Action::Check { .. }
            | Action::Uncheck { .. }
            | Action::Focus { .. }
            | Action::SelectAll { .. }
            | Action::Hover { .. }
            | Action::Highlight { .. }
            | Action::ScrollIntoView { .. }
            | Action::Select { .. }
            | Action::Drag { .. }
            | Action::Fill { .. } => unreachable!("element actions bind the observed node"),
            Action::Scroll { .. } => unreachable!("scrolling follows the Host renderer clock"),
            Action::InsertText { .. } => unreachable!("insertion follows the Host renderer clock"),
            Action::TypeText { .. } => {
                unreachable!("typing uses admitted insertion and keyboard contacts")
            }
            Action::Press { .. }
            | Action::Clipboard { .. }
            | Action::KeyDown { .. }
            | Action::KeyUp { .. } => {
                unreachable!("Host owns held keys and key chords")
            }
            Action::Evaluate { .. } => unreachable!("evaluation follows the Host renderer clock"),
            Action::WaitFunction { .. } => unreachable!("function waits use admitted probes"),
            Action::NewPage { .. } | Action::NewWindow {} => {
                unreachable!("page creation installs observation before navigation")
            }
            Action::SelectPage => vec![json!({"action":"tab_list"})],
            Action::ClosePage => vec![json!({"action":"tab_close"})],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn isolated_window_creation_cannot_supply_a_native_context_or_destination() {
        let parsed = serde_json::from_value::<BrowserAction>(json!({"kind":"new_window"})).unwrap();
        assert!(matches!(
            parsed.new_page(),
            Some((
                "about:blank",
                super::super::events::PageCreationContext::Isolated
            ))
        ));
        for extra in ["browserContextId", "targetId", "url", "profile"] {
            let mut request = json!({"kind":"new_window"});
            request[extra] = json!("peer");
            assert!(serde_json::from_value::<BrowserAction>(request).is_err());
        }
    }

    #[test]
    fn swipe_rejects_out_of_range_endpoints_before_starting_a_contact() {
        for (direction, distance) in [
            ("right", 999_800),
            ("down", 999_600),
            ("up", 1_000_000),
            ("left", 1_000_000),
        ] {
            assert!(
                serde_json::from_value::<BrowserAction>(
                    json!({"kind":"swipe","direction":direction,"distance":distance})
                )
                .is_ok()
            );
            assert!(
                serde_json::from_value::<BrowserAction>(
                    json!({"kind":"swipe","direction":direction,"distance":distance+1})
                )
                .is_err()
            );
        }
        for value in [
            json!({"kind":"swipe","direction":"north","distance":30}),
            json!({"kind":"swipe","direction":"up","distance":-1}),
            json!({"kind":"swipe","direction":"up","distance":30,"target":"peer"}),
        ] {
            assert!(serde_json::from_value::<BrowserAction>(value).is_err());
        }
    }

    #[test]
    fn push_state_accepts_relative_and_empty_urls_but_bounds_renderer_input() {
        for url in [
            "",
            "../한글 route",
            "#part",
            "?page=2",
            "https://example.com/path",
        ] {
            let action: BrowserAction =
                serde_json::from_value(json!({"kind":"push_state","url":url})).unwrap();
            assert_eq!(action.push_state_url(), Some(url));
            assert!(action.uses_document());
            assert!(!action.replaces_elements());
        }
        for value in [
            json!({"kind":"push_state"}),
            json!({"kind":"push_state","url":7}),
            json!({"kind":"push_state","url":"한".repeat(2731)}),
            json!({"kind":"push_state","url":"/path","resource":"peer"}),
        ] {
            assert!(serde_json::from_value::<BrowserAction>(value).is_err());
        }
    }

    #[test]
    fn clipboard_shortcuts_require_a_known_operation_and_use_keyboard_admission() {
        for operation in ["copy", "paste"] {
            let action: BrowserAction =
                serde_json::from_value(json!({"kind":"clipboard","operation":operation})).unwrap();
            assert!(matches!(
                action.keyboard(),
                Some(super::super::keyboard::KeyboardAction::Clipboard(_))
            ));
        }
        for value in [
            json!({"kind":"clipboard"}),
            json!({"kind":"clipboard","operation":"write"}),
            json!({"kind":"clipboard","operation":"paste","text":"unrequested"}),
            json!({"kind":"clipboard","operation":"copy","platform":"macos"}),
        ] {
            assert!(serde_json::from_value::<BrowserAction>(value).is_err());
        }
    }

    #[test]
    fn recording_defaults_to_mp4_and_admits_webm_only_at_stop() {
        use super::super::recording::{RecordingAction, RecordingFormat};
        let parse = |value| serde_json::from_value::<BrowserAction>(value);
        assert!(matches!(
            parse(json!({"kind":"record","action":"start"}))
                .unwrap()
                .recording(),
            Some((RecordingAction::Start, RecordingFormat::Mp4))
        ));
        assert!(matches!(
            parse(json!({"kind":"record","action":"stop"}))
                .unwrap()
                .recording(),
            Some((RecordingAction::Stop, RecordingFormat::Mp4))
        ));
        assert!(matches!(
            parse(json!({"kind":"record","action":"stop","format":"webm"}))
                .unwrap()
                .recording(),
            Some((RecordingAction::Stop, RecordingFormat::Webm))
        ));
        for value in [
            json!({"kind":"record","action":"start","format":"webm"}),
            json!({"kind":"record","action":"stop","format":"avi"}),
            json!({"kind":"record","action":"stop","unexpected":true}),
        ] {
            assert!(parse(value).is_err());
        }
    }

    #[test]
    fn highlight_retains_snapshot_authority_and_rejects_engine_aliases() {
        let reference = json!({
            "snapshot": {"page": {"resource": {"resource_id":"resource", "generation":"generation", "workspace_id":"workspace"}, "page_id":"page", "document_revision":"4"}, "revision":"12"},
            "element":"e9"
        });
        let action: BrowserAction = serde_json::from_value(
            json!({"kind":"highlight","target":{"kind":"reference","reference":reference}}),
        )
        .unwrap();
        assert_eq!(action.references().count(), 1);
        assert_eq!(
            serde_json::to_value(action.references().next().unwrap()).unwrap(),
            reference
        );
        assert!(matches!(
            action.element_action(),
            Some((_, FindAction::Highlight))
        ));
        assert!(!action.replaces_elements());
        for selector in ["@e1", "ref=e1", "e1", "  ref=e7  ", "@e"] {
            assert!(
                serde_json::from_value::<BrowserAction>(
                    json!({"kind":"highlight","target":{"kind":"css","selector":selector}})
                )
                .is_err()
            );
        }
        assert!(
            serde_json::from_value::<BrowserAction>(
                json!({"kind":"highlight","target":{"kind":"css","selector":"#e1"}})
            )
            .is_ok()
        );
    }

    #[test]
    fn engine_ref_aliases_cannot_bypass_snapshot_authority_as_css() {
        for selector in ["@e1", "ref=e1", "e1", "  ref=e7  ", "@e"] {
            let action = json!({"kind":"click","target":{"kind":"css","selector":selector}});
            assert!(
                serde_json::from_value::<BrowserAction>(action).is_err(),
                "engine ref alias admitted without a Host reference: {selector}"
            );
        }
        let actual_css = json!({"kind":"click","target":{"kind":"css","selector":"#e1"}});
        assert!(serde_json::from_value::<BrowserAction>(actual_css).is_ok());
    }
}
