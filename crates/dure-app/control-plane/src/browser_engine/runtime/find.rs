use super::locator::{BrowserLocator, LocatedElement};
use super::{BrowserActionPermit, BrowserRuntimeError, Execution};
use crate::browser_engine::{BrowserEngineError, NativeBrowserEngine, NativeBrowserResponse};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum FindAction {
    #[serde(skip_deserializing)]
    Tap,
    Click,
    #[serde(skip_deserializing)]
    DoubleClick,
    #[serde(skip_deserializing)]
    SelectAll,
    #[serde(skip_deserializing)]
    ScrollIntoView,
    #[serde(skip_deserializing)]
    Highlight,
    #[serde(skip_deserializing)]
    Select {
        values: Vec<String>,
    },
    Hover,
    Check,
    Uncheck,
    Focus,
    Fill {
        text: String,
    },
    Type {
        text: String,
    },
}

impl FindAction {
    pub(super) fn validate(&self) -> Result<(), &'static str> {
        if matches!(self, Self::Fill { text } | Self::Type { text } if text.len() > 64 * 1024) {
            return Err("browser_text_too_large");
        }
        Ok(())
    }
}

impl Execution<'_> {
    pub(super) async fn find_action(
        &self,
        engine: &mut NativeBrowserEngine,
        permit: &BrowserActionPermit,
        cdp: super::BrowserCdp,
        find: (&BrowserLocator, &FindAction),
    ) -> Result<NativeBrowserResponse, BrowserRuntimeError> {
        let (locator, action) = find;
        let target = self
            .resource
            .host
            .lock()
            .await
            .dispatch_target(permit)?
            .clone();
        let mut element = LocatedElement::resolve(cdp, target.as_str(), locator).await?;
        self.act_on_element(engine, permit, &mut element, action)
            .await
    }

    pub(super) async fn bound_element_action(
        &self,
        engine: &mut NativeBrowserEngine,
        permit: &BrowserActionPermit,
        cdp: super::BrowserCdp,
        target: &super::BrowserElementTarget,
        action: &FindAction,
    ) -> Result<NativeBrowserResponse, BrowserRuntimeError> {
        let page = self
            .resource
            .host
            .lock()
            .await
            .dispatch_target(permit)?
            .clone();
        let mut element = target.resolve(cdp, page.as_str()).await?;
        self.act_on_element(engine, permit, &mut element, action)
            .await
    }

    pub(super) async fn act_on_element(
        &self,
        engine: &mut NativeBrowserEngine,
        permit: &BrowserActionPermit,
        element: &mut LocatedElement,
        action: &FindAction,
    ) -> Result<NativeBrowserResponse, BrowserRuntimeError> {
        self.validate_find(engine, permit, element).await?;
        if matches!(action, FindAction::Highlight) {
            // Display feedback also applies to disabled elements and never moves focus.
            // A lost mutation reply still belongs to the existing uncertainty fence.
            let result = element.call("function(){if(!this.isConnected)throw Error();this.style.outline='2px solid red';this.style.outlineOffset='2px';setTimeout(()=>{this.style.outline='';this.style.outlineOffset='';},3000);return true;}").await
                .map(|_| response(json!({"highlighted":true})))
                .map_err(BrowserRuntimeError::from);
            return finish_element_result(result);
        }
        let state = element.call("function(){return {disabled:this.matches(':disabled')||this.getAttribute('aria-disabled')==='true',editable:(this instanceof HTMLInputElement && !['checkbox','radio','button','submit','reset','file','hidden','range','color'].includes(this.type))||this instanceof HTMLTextAreaElement||this.isContentEditable,readonly:!!this.readOnly,checked:typeof this.checked==='boolean'?this.checked:this.getAttribute('aria-checked')==='true'?true:this.getAttribute('aria-checked')==='false'?false:null};}").await?;
        if state["disabled"] == true {
            return Err("browser_element_disabled".into());
        }
        if matches!(action, FindAction::Fill { .. } | FindAction::Type { .. })
            && (state["editable"] != true || state["readonly"] == true)
        {
            return Err("browser_element_not_editable".into());
        }
        let checked = match action {
            FindAction::Check => Some(true),
            FindAction::Uncheck => Some(false),
            _ => None,
        };
        if let Some(desired) = checked {
            if state["checked"].as_bool().is_none() {
                return Err("browser_element_not_checkable".into());
            }
            if state["checked"] == desired {
                return Ok(response(json!({"checked":desired})));
            }
        }
        // From the first focus/scroll/input onward a lost reply may conceal a
        // page-side effect. Keep the existing journal/Host uncertainty fence.
        let result: Result<_, BrowserRuntimeError> = async {
            match action {
                FindAction::Highlight => unreachable!("highlight does not require an actionable element"),
                FindAction::Focus
                | FindAction::SelectAll
                | FindAction::Fill { .. }
                | FindAction::Type { .. } => {
                    element.node_command("DOM.focus").await?;
                    self.validate_find(engine, permit, element).await?;
                    if matches!(action, FindAction::Fill { .. } | FindAction::SelectAll) {
                        element.call("function(){if(!this.isConnected||this.getRootNode().activeElement!==this)throw Error();if(this.isContentEditable){const range=this.ownerDocument.createRange();range.selectNodeContents(this);const selection=this.ownerDocument.getSelection();selection.removeAllRanges();selection.addRange(range);}else{this.select();}return true;}").await?;
                        self.validate_find(engine, permit, element).await?;
                    }
                    if let FindAction::Fill { text } | FindAction::Type { text } = action {
                        let focused = element.call("function(){return this.isConnected&&this.getRootNode().activeElement===this;}").await?;
                        if focused != true {
                            return Err("browser_element_focus_changed".into());
                        }
                        if matches!(action, FindAction::Fill { .. }) && text.is_empty() {
                            let page = {
                                let host = self.resource.host.lock().await;
                                let target = host.dispatch_target(permit)?;
                                host.page_for_target(target).ok_or("browser_page_missing")?
                            };
                            let chord = "Backspace".to_owned().try_into().expect("built-in key chord");
                            return self.keyboard_action(engine, permit, &page, super::keyboard::KeyboardAction::Press(&chord)).await;
                        }
                        return if matches!(action, FindAction::Type { .. }) {
                            self.type_text(engine, permit, element.cdp.clone(), text).await
                        } else {
                            self.insert_text(permit, element.cdp.clone(), text).await
                        };
                    }
                    Ok(response(json!({"focused":true})))
                }
                FindAction::Select { values } => {
                    let values = json!(values);
                    let selected = element.call(&format!("function(){{if(!this.isConnected||!(this instanceof HTMLSelectElement)||this.matches(':disabled'))throw Error();const values={values};if(!this.multiple&&values.length!==1)throw Error();const options=values.map(value=>Array.from(this.options).find(option=>option.value===value||option.label===value));if(options.some(option=>!option||option.disabled))throw Error();for(const option of this.options)option.selected=options.includes(option);this.dispatchEvent(new Event('input',{{bubbles:true}}));this.dispatchEvent(new Event('change',{{bubbles:true}}));return Array.from(this.selectedOptions,option=>option.value);}}")).await?;
                    Ok(response(json!({"values":selected})))
                }
                FindAction::Tap
                | FindAction::Click
                | FindAction::DoubleClick
                | FindAction::Hover
                | FindAction::ScrollIntoView
                | FindAction::Check
                | FindAction::Uncheck => {
                    element.node_command("DOM.scrollIntoViewIfNeeded").await?;
                    self.validate_find(engine, permit, element).await?;
                    if matches!(action, FindAction::ScrollIntoView) {
                        return Ok(response(json!({"scrolled":true})));
                    }
                    let position = pointer_position(element).await?;
                    if matches!(action, FindAction::Tap) {
                        self.tap_action(permit, &position).await?;
                        return Ok(response(json!({"tapped":true})));
                    }
                    self.element_pointer(permit, "mouseMoved", &position, 0).await?;
                    if matches!(action, FindAction::Hover) {
                        return Ok(response(json!({"hovered":true})));
                    }
                    // Hover handlers may replace, move or cover the located node.
                    self.validate_find(engine, permit, element).await?;
                    let count = if matches!(action, FindAction::DoubleClick) { 2 } else { 1 };
                    for click in 1..=count {
                        if click > 1 {
                            self.validate_find(engine, permit, element).await?;
                        }
                        let position = pointer_position(element).await?;
                        self.element_pointer(permit, "mousePressed", &position, click).await?;
                        // Release belongs to the same admitted gesture even if its
                        // mousedown handler navigates; never leave a known press held.
                        self.element_pointer(permit, "mouseReleased", &position, click).await?;
                    }
                    if let Some(desired) = checked {
                        let actual = element.call("function(){return typeof this.checked==='boolean'?this.checked:this.getAttribute('aria-checked')==='true';}").await?;
                        if actual != desired {
                            return Ok(NativeBrowserResponse {
                                success: false,
                                error: Some("browser_checked_state_unchanged".into()),
                                ..response(json!({"checked":actual}))
                            });
                        }
                        return Ok(response(json!({"checked":desired})));
                    }
                    Ok(response(json!({"clicked":true})))
                }
            }
        }
        .await;
        finish_element_result(result)
    }

    pub(super) async fn validate_find(
        &self,
        engine: &mut NativeBrowserEngine,
        permit: &BrowserActionPermit,
        element: &mut LocatedElement,
    ) -> Result<(), BrowserRuntimeError> {
        self.observe_engine(engine).await?;
        self.resource.host.lock().await.dispatch_frame(permit)?;
        if element.call("function(){return this.isConnected;}").await? != true {
            return Err("browser_element_changed".into());
        }
        Ok(())
    }
}

pub(super) fn finish_element_result(
    result: Result<NativeBrowserResponse, BrowserRuntimeError>,
) -> Result<NativeBrowserResponse, BrowserRuntimeError> {
    match result {
        Ok(response) => Ok(response),
        Err(BrowserRuntimeError::Engine(error)) if error.outcome_unknown => Err(error.into()),
        Err(BrowserRuntimeError::Observation(code))
            if code.starts_with("browser_cdp_")
                || matches!(
                    code,
                    "browser_renderer_lifecycle_changed" | "browser_frame_context_changed"
                ) =>
        {
            Err(BrowserEngineError::after("browser_find_incomplete").into())
        }
        // Every preceding step has a known reply. A changed/covered element
        // ends this operation without replay and lets a handoff drain.
        Err(error) => {
            let code = match error {
                BrowserRuntimeError::Observation(code) => code,
                BrowserRuntimeError::Engine(error) => error.code,
                BrowserRuntimeError::Admission(_) => "browser_find_target_changed",
            };
            Ok(NativeBrowserResponse {
                success: false,
                error: Some(code.into()),
                ..response(json!({}))
            })
        }
    }
}

pub(super) async fn pointer_position(element: &mut LocatedElement) -> Result<Value, &'static str> {
    let point = element.call("function(){if(!this.isConnected||this.matches(':disabled')||getComputedStyle(this).visibility!=='visible')return null;const r=this.getBoundingClientRect();const left=Math.max(0,r.left),right=Math.min(innerWidth,r.right),top=Math.max(0,r.top),bottom=Math.min(innerHeight,r.bottom);if(left>=right||top>=bottom)return null;const x=(left+right)/2,y=(top+bottom)/2;const hit=this.getRootNode().elementFromPoint(x,y);return hit&&(hit===this||this.contains(hit))?{x,y}:null;}").await?;
    if !point["x"].as_f64().is_some_and(f64::is_finite)
        || !point["y"].as_f64().is_some_and(f64::is_finite)
    {
        return Err("browser_element_not_reachable");
    }
    element.cdp.page_point(point).await
}

pub(super) fn response(data: Value) -> NativeBrowserResponse {
    NativeBrowserResponse {
        id: "browser-find".into(),
        success: true,
        data,
        error: None,
    }
}
