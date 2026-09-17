use super::{BrowserActionPermit, BrowserCdp, BrowserRuntimeError, Execution};
use crate::browser_engine::{BrowserEngineError, NativeBrowserEngine, NativeBrowserResponse};
use hmux_host::browser_resource::keyboard::BrowserKeyboardDispatch;
use hmux_session_protocol::{
    browser_keyboard::{BrowserKey, BrowserKeyChord},
    browser_resource::BrowserPageIdentity,
};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum ClipboardOperation {
    Copy,
    Paste,
}

impl ClipboardOperation {
    fn chord(self) -> BrowserKeyChord {
        let modifier = if cfg!(target_os = "macos") {
            "Meta"
        } else {
            "Control"
        };
        let key = match self {
            Self::Copy => "c",
            Self::Paste => "v",
        };
        BrowserKeyChord::try_from(format!("{modifier}+{key}")).expect("built-in clipboard shortcut")
    }

    fn receipt(self) -> Value {
        match self {
            Self::Copy => json!({"copied":true}),
            Self::Paste => json!({"pasted":true}),
        }
    }
}

#[derive(Clone, Copy)]
pub(super) enum KeyboardAction<'a> {
    Down(&'a BrowserKey),
    Up(&'a BrowserKey),
    Press(&'a BrowserKeyChord),
    Clipboard(ClipboardOperation),
}

impl Execution<'_> {
    pub(super) async fn type_text(
        &self,
        engine: &mut NativeBrowserEngine,
        permit: &BrowserActionPermit,
        cdp: BrowserCdp,
        text: &str,
    ) -> Result<NativeBrowserResponse, BrowserRuntimeError> {
        let mut processed = 0;
        let result = async {
            for character in text.chars() {
                if processed != 0 {
                    // Input handlers can navigate. Refresh the existing Host
                    // fence before the next character, without replaying it.
                    self.observe_engine(engine).await?;
                }
                let page = {
                    let host = self.resource.host.lock().await;
                    let target = host.dispatch_target(permit)?;
                    host.dispatch_frame(permit)?;
                    host.page_for_target(target).ok_or("browser_page_missing")?
                };
                if matches!(character, '\n' | '\r' | '\t') {
                    let chord = BrowserKeyChord::try_from(
                        if character == '\t' { "Tab" } else { "Enter" }.to_owned(),
                    )
                    .expect("built-in typing control");
                    self.keyboard_action(engine, permit, &page, KeyboardAction::Press(&chord))
                        .await?;
                } else {
                    self.insert_text(permit, cdp.clone(), &character.to_string())
                        .await?;
                }
                processed += 1;
            }
            Ok(NativeBrowserResponse {
                id: "browser-keyboard-type".into(),
                success: true,
                data: json!({"typed":text}),
                error: None,
            })
        }
        .await;
        // Known partial input is a completed, unsuccessful operation. A lost
        // native acknowledgement retains the existing outcome-unknown fence.
        let mut response = super::find::finish_element_result(result)?;
        if !response.success {
            response.data = json!({"processed_characters":processed});
        }
        Ok(response)
    }

    async fn key_event(
        &self,
        permit: &BrowserActionPermit,
        key: BrowserKey,
        down: bool,
    ) -> Result<(), BrowserRuntimeError> {
        let event = self
            .resource
            .host
            .lock()
            .await
            .prepare_key(permit, key, down)?;
        self.dispatch_keyboard(event).await
    }

    pub(super) async fn dispatch_keyboard(
        &self,
        event: BrowserKeyboardDispatch,
    ) -> Result<(), BrowserRuntimeError> {
        let mut cdp = self.renderer_cdp(self.binding.cdp.clone(), event.target().clone());
        let session = match cdp.attach(event.target().as_str()).await {
            Ok(session) => session,
            Err(_) => {
                self.resource
                    .host
                    .lock()
                    .await
                    .keyboard_delivery_unknown(event)?;
                return Err(
                    BrowserEngineError::after("browser_keyboard_session_unavailable").into(),
                );
            }
        };
        let params = key_parameters(&event);
        if cdp
            .request("Input.dispatchKeyEvent", params, Some(&session))
            .await
            .is_err()
        {
            self.resource
                .host
                .lock()
                .await
                .keyboard_delivery_unknown(event)?;
            return Err(BrowserEngineError::after("browser_keyboard_outcome_unknown").into());
        }
        self.resource
            .host
            .lock()
            .await
            .keyboard_applied(event)
            .map_err(|_| BrowserEngineError::after("browser_keyboard_acknowledgement_lost"))?;
        Ok(())
    }

    pub(super) async fn keyboard_action(
        &self,
        engine: &mut NativeBrowserEngine,
        permit: &BrowserActionPermit,
        page: &BrowserPageIdentity,
        action: KeyboardAction<'_>,
    ) -> Result<NativeBrowserResponse, BrowserRuntimeError> {
        let clipboard = match action {
            KeyboardAction::Clipboard(operation) => Some(operation),
            _ => None,
        };
        let shortcut = clipboard.map(ClipboardOperation::chord);
        // Resolve the host's shortcut before entering the same held-key and
        // acknowledgement path as an explicit chord, including page handlers.
        let action = shortcut
            .as_ref()
            .map(KeyboardAction::Press)
            .unwrap_or(action);
        let data = match action {
            KeyboardAction::Clipboard(_) => unreachable!("clipboard resolved to a key chord"),
            KeyboardAction::Down(key) => {
                self.key_event(permit, key.clone(), true).await?;
                json!({"keydown":key})
            }
            KeyboardAction::Up(key) => {
                self.key_event(permit, key.clone(), false).await?;
                json!({"keyup":key})
            }
            KeyboardAction::Press(chord) => {
                let mut owned = Vec::new();
                let pressed: Result<(), BrowserRuntimeError> = async {
                    for (index, key) in chord.keys().iter().enumerate() {
                        if index != 0 {
                            self.observe_engine(engine).await.map_err(|_| {
                                BrowserEngineError::after("browser_keyboard_chord_unobserved")
                            })?;
                        }
                        let held = self.resource.host.lock().await.key_held(page, key);
                        self.key_event(permit, key.clone(), true).await?;
                        if !held {
                            owned.push(key.clone());
                        }
                    }
                    Ok(())
                }
                .await;
                // Release only this chord's new contacts, preserving keys held by
                // preceding commands. An unknown delivery is already fenced.
                if !matches!(&pressed,Err(BrowserRuntimeError::Engine(error)) if error.outcome_unknown)
                {
                    for key in owned.into_iter().rev() {
                        if self.resource.host.lock().await.key_held(page, &key) {
                            self.key_event(permit, key, false).await?;
                        }
                    }
                }
                pressed?;
                json!({"pressed":chord.as_str()})
            }
        };
        Ok(NativeBrowserResponse {
            id: "browser-keyboard".into(),
            success: true,
            data: clipboard.map(ClipboardOperation::receipt).unwrap_or(data),
            error: None,
        })
    }
}

fn key_parameters(event: &BrowserKeyboardDispatch) -> Value {
    let modifiers = event.modifiers();
    let key = event.key().key(modifiers);
    let code = event.key().code();
    let text = if event.down() && modifiers & (2 | 4) == 0 {
        match key.as_str() {
            "Enter" => Some("\r"),
            "Tab" => Some("\t"),
            value if value.chars().count() == 1 => Some(value),
            _ => None,
        }
    } else {
        None
    };
    let mut params = json!({
        "type": if !event.down() { "keyUp" } else if text.is_some() { "keyDown" } else { "rawKeyDown" },
        "key": key,
        "code": code,
        "modifiers": modifiers,
        "location": event.key().location(),
        "isKeypad": event.key().location() == 3,
        "autoRepeat": event.repeat(),
        "windowsVirtualKeyCode": virtual_key(code),
    });
    if let Some(text) = text {
        params["text"] = text.into();
        params["unmodifiedText"] = text.into();
    }
    if event.down() && cfg!(target_os = "macos") {
        if let Some(command) = mac_editing_command(code, modifiers) {
            params["commands"] = json!([command]);
        }
    }
    params
}

// CDP bypasses AppKit's translation of shortcuts into editing commands.
// Send the command on the key event so Chromium still owns default editing
// and honors the page's preventDefault(), including in contenteditable.
fn mac_editing_command(code: &str, modifiers: u8) -> Option<String> {
    let shift = modifiers & 8 != 0;
    let command = match (modifiers, code) {
        (4, "KeyA") => "selectAll",
        (4, "KeyC") => "copy",
        (4, "KeyX") => "cut",
        (4, "KeyV") => "paste",
        (4, "KeyZ") => "undo",
        (12, "KeyZ") => "redo",
        (4, "Backspace") => "deleteToBeginningOfLine",
        (1, "Backspace") => "deleteWordBackward",
        (1, "Delete") => "deleteWordForward",
        _ => {
            let movement = match (modifiers & !8, code) {
                (4, "ArrowLeft") => "moveToLeftEndOfLine",
                (4, "ArrowRight") => "moveToRightEndOfLine",
                (4, "ArrowUp") => "moveToBeginningOfDocument",
                (4, "ArrowDown") => "moveToEndOfDocument",
                (1, "ArrowLeft") => "moveWordLeft",
                (1, "ArrowRight") => "moveWordRight",
                (2, "KeyA") => "moveToBeginningOfParagraph",
                (2, "KeyE") => "moveToEndOfParagraph",
                (2, "KeyB") => "moveBackward",
                (2, "KeyF") => "moveForward",
                (2, "KeyP") => "moveUp",
                (2, "KeyN") => "moveDown",
                _ => return None,
            };
            return Some(if shift {
                format!("{movement}AndModifySelection")
            } else {
                movement.into()
            });
        }
    };
    Some(command.into())
}

// CDP uses Windows virtual-key values on every platform. DOM code identity
// stays in the neutral protocol; this conversion belongs to the engine adapter.
fn virtual_key(code: &str) -> u16 {
    if let Some(letter) = code
        .strip_prefix("Key")
        .filter(|v| v.len() == 1 && v.as_bytes()[0].is_ascii_uppercase())
    {
        return u16::from(letter.as_bytes()[0]);
    }
    if let Some(digit) = code
        .strip_prefix("Digit")
        .filter(|v| v.len() == 1 && v.as_bytes()[0].is_ascii_digit())
    {
        return u16::from(digit.as_bytes()[0]);
    }
    if let Some(number) = code
        .strip_prefix('F')
        .and_then(|v| v.parse::<u16>().ok())
        .filter(|v| (1..=24).contains(v))
    {
        return 111 + number;
    }
    match code {
        "Backspace" => 8,
        "Tab" => 9,
        "Enter" | "NumpadEnter" => 13,
        "ShiftLeft" | "ShiftRight" => 16,
        "ControlLeft" | "ControlRight" => 17,
        "AltLeft" | "AltRight" => 18,
        "Pause" => 19,
        "CapsLock" => 20,
        "Escape" => 27,
        "Space" => 32,
        "PageUp" => 33,
        "PageDown" => 34,
        "End" => 35,
        "Home" => 36,
        "ArrowLeft" => 37,
        "ArrowUp" => 38,
        "ArrowRight" => 39,
        "ArrowDown" => 40,
        "PrintScreen" => 44,
        "Insert" => 45,
        "Delete" => 46,
        "MetaLeft" => 91,
        "MetaRight" => 92,
        "ContextMenu" => 93,
        "NumLock" => 144,
        "ScrollLock" => 145,
        "Semicolon" => 186,
        "Equal" => 187,
        "Comma" => 188,
        "Minus" => 189,
        "Period" => 190,
        "Slash" => 191,
        "Backquote" => 192,
        "BracketLeft" => 219,
        "Backslash" => 220,
        "BracketRight" => 221,
        "Quote" => 222,
        _ => 0,
    }
}
