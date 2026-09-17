use super::BrowserCdp;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Deserialize, Serialize)]
#[serde(try_from = "Locator")]
pub(super) struct BrowserLocator(Locator);

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Locator {
    Role {
        value: String,
        name: Option<String>,
        exact: bool,
    },
    Text {
        value: String,
        exact: bool,
    },
    Label {
        value: String,
        exact: bool,
    },
    Placeholder {
        value: String,
        exact: bool,
    },
    Alt {
        value: String,
        exact: bool,
    },
    Title {
        value: String,
        exact: bool,
    },
    Testid {
        value: String,
        exact: bool,
    },
    Nth {
        selector: String,
        index: i32,
    },
}

impl TryFrom<Locator> for BrowserLocator {
    type Error = &'static str;
    fn try_from(locator: Locator) -> Result<Self, Self::Error> {
        let value = match &locator {
            Locator::Role { value, name, .. } => {
                if value.len() > 128 || name.as_ref().is_some_and(|name| name.len() > 8192) {
                    return Err("browser_find_invalid");
                }
                value
            }
            Locator::Text { value, .. }
            | Locator::Label { value, .. }
            | Locator::Placeholder { value, .. }
            | Locator::Alt { value, .. }
            | Locator::Title { value, .. }
            | Locator::Testid { value, .. } => value,
            Locator::Nth { selector, index } => {
                if !(-999_999..=999_999).contains(index) {
                    return Err("browser_find_invalid");
                }
                selector
            }
        };
        if value.is_empty() || value.len() > 8192 {
            return Err("browser_find_invalid");
        }
        Ok(Self(locator))
    }
}

impl BrowserLocator {
    pub(super) fn first(selector: &str) -> Self {
        Self(Locator::Nth {
            selector: selector.into(),
            index: 0,
        })
    }
}

/// A connection-local node handle. It never enters a public selector/ref table.
pub(super) struct LocatedElement {
    pub(super) cdp: BrowserCdp,
    pub(super) session: String,
    object: String,
    group: crate::browser_engine::cdp::BrowserObjectGroup,
}

impl LocatedElement {
    pub(super) async fn resolve_node(
        mut cdp: BrowserCdp,
        target: &str,
        backend: i64,
    ) -> Result<Self, &'static str> {
        let (session, context) = attach_context(&mut cdp, target).await?;
        let group = cdp.object_group(&session)?;
        let value = cdp
            .request(
                "DOM.resolveNode",
                json!({"backendNodeId":backend,"executionContextId":context,"objectGroup":group.name()}),
                Some(&session),
            )
            .await?;
        let object = value["object"]["objectId"]
            .as_str()
            .ok_or("browser_element_changed")?
            .to_owned();
        let mut element = Self {
            cdp,
            session,
            object,
            group,
        };
        if element.call("function(){return this.isConnected;}").await? != true {
            return Err("browser_element_changed");
        }
        Ok(element)
    }

    pub(super) async fn resolve(
        mut cdp: BrowserCdp,
        target: &str,
        locator: &BrowserLocator,
    ) -> Result<Self, &'static str> {
        let (session, context) = attach_context(&mut cdp, target).await?;
        let group = cdp.object_group(&session)?;
        let role = match &locator.0 {
            Locator::Role { value, name, exact }
                if !["none", "presentation", "directory"]
                    .contains(&value.to_ascii_lowercase().as_str()) =>
            {
                let tree = cdp.accessibility_tree(&session).await?;
                let node = tree["nodes"]
                    .as_array()
                    .ok_or("browser_accessibility_invalid")?
                    .iter()
                    .find(|node| {
                        node["ignored"] != true
                            && normalize_role(node["role"]["value"].as_str().unwrap_or_default())
                                == normalize_role(value)
                            && name.as_ref().is_none_or(|name| {
                                matches_name(
                                    node["name"]["value"].as_str().unwrap_or_default(),
                                    name,
                                    *exact,
                                )
                            })
                            && node["backendDOMNodeId"].as_i64().is_some()
                    })
                    .ok_or("browser_element_not_found")?;
                Some(node["backendDOMNodeId"].clone())
            }
            _ => None,
        };
        let object = if let Some(backend) = role {
            let result = cdp
                .request(
                    "DOM.resolveNode",
                    json!({"backendNodeId":backend,"executionContextId":context,"objectGroup":group.name()}),
                    Some(&session),
                )
                .await?;
            result["object"]["objectId"]
                .as_str()
                .ok_or("browser_element_not_found")?
                .to_owned()
        } else {
            let expression = format!(
                "({})({})",
                include_str!("locator.js"),
                serde_json::to_string(&locator.0).map_err(|_| "browser_find_invalid")?
            );
            let result = cdp
                .request(
                    "Runtime.evaluate",
                    json!({"expression":expression,"contextId":context,"returnByValue":false,"objectGroup":group.name()}),
                    Some(&session),
                )
                .await?;
            if result.get("exceptionDetails").is_some() {
                return Err("browser_selector_invalid");
            }
            result["result"]["objectId"]
                .as_str()
                .ok_or("browser_element_not_found")?
                .to_owned()
        };
        Ok(Self {
            cdp,
            session,
            object,
            group,
        })
    }

    pub(super) async fn call(&mut self, function: &str) -> Result<Value, &'static str> {
        let result = self
            .cdp
            .request(
                "Runtime.callFunctionOn",
                json!({"objectId":self.object,"functionDeclaration":function,"returnByValue":true,"objectGroup":self.group.name()}),
                Some(&self.session),
            )
            .await?;
        if result.get("exceptionDetails").is_some() {
            return Err("browser_element_changed");
        }
        Ok(result["result"]["value"].clone())
    }

    pub(super) async fn page_box(&mut self) -> Result<Value, &'static str> {
        let model = self
            .cdp
            .request(
                "DOM.getBoxModel",
                json!({"objectId":self.object}),
                Some(&self.session),
            )
            .await?;
        let border = model["model"]["border"]
            .as_array()
            .filter(|quad| quad.len() == 8)
            .ok_or("browser_element_not_visible")?;
        let mut quad = [[0.0; 2]; 4];
        for (point, coordinates) in quad.iter_mut().zip(border.chunks_exact(2)) {
            for (value, coordinate) in point.iter_mut().zip(coordinates) {
                *value = coordinate
                    .as_f64()
                    .filter(|value| value.is_finite())
                    .ok_or("browser_capture_dimensions_invalid")?;
            }
        }
        self.cdp.page_quad(&mut quad).await?;
        let x = quad
            .iter()
            .map(|point| point[0])
            .fold(f64::INFINITY, f64::min);
        let y = quad
            .iter()
            .map(|point| point[1])
            .fold(f64::INFINITY, f64::min);
        let right = quad
            .iter()
            .map(|point| point[0])
            .fold(f64::NEG_INFINITY, f64::max);
        let bottom = quad
            .iter()
            .map(|point| point[1])
            .fold(f64::NEG_INFINITY, f64::max);
        if right <= x || bottom <= y {
            return Err("browser_element_not_visible");
        }
        Ok(json!({"x":x,"y":y,"width":right-x,"height":bottom-y}))
    }

    pub(super) async fn node_command(&mut self, method: &str) -> Result<(), &'static str> {
        self.cdp
            .request(method, json!({"objectId":self.object}), Some(&self.session))
            .await?;
        Ok(())
    }

    pub(super) async fn frame_id(
        &mut self,
    ) -> Result<hmux_session_protocol::browser_resource::BrowserFrameId, &'static str> {
        let result = self.describe(1).await?;
        let node = &result["node"];
        if !matches!(node["nodeName"].as_str(), Some("IFRAME" | "FRAME")) {
            return Err("browser_element_not_frame");
        }
        let id = node["contentDocument"]["frameId"]
            .as_str()
            .or_else(|| node["frameId"].as_str())
            .ok_or("browser_frame_missing")?;
        hmux_session_protocol::browser_resource::BrowserFrameId::new(id)
            .map_err(|_| "browser_frame_invalid")
    }

    pub(super) async fn describe(&mut self, depth: i32) -> Result<Value, &'static str> {
        self.cdp
            .request(
                "DOM.describeNode",
                json!({"objectId":self.object,"depth":depth}),
                Some(&self.session),
            )
            .await
    }

    pub(super) async fn set_files(
        &mut self,
        paths: &[std::path::PathBuf],
    ) -> Result<(), &'static str> {
        self.cdp
            .request(
                "DOM.setFileInputFiles",
                json!({"objectId":self.object,"files":paths}),
                Some(&self.session),
            )
            .await?;
        Ok(())
    }

    pub(super) async fn text(&mut self) -> Result<Value, &'static str> {
        self.call("function(){if(!this.isConnected)throw Error();return this.textContent;}")
            .await
    }
}

async fn attach_context(cdp: &mut BrowserCdp, target: &str) -> Result<(String, i64), &'static str> {
    let session = cdp.attach(target).await?;
    let context = cdp.isolated_context(&session).await?;
    Ok((session, context))
}

fn normalize_role(role: &str) -> String {
    match role.to_ascii_lowercase().as_str() {
        "image" => "img".into(),
        "rootwebarea" => "document".into(),
        other => other.into(),
    }
}

fn matches_name(actual: &str, expected: &str, exact: bool) -> bool {
    let normalized = |text: &str| text.split_whitespace().collect::<Vec<_>>().join(" ");
    if exact {
        normalized(actual) == normalized(expected)
    } else {
        normalized(actual)
            .to_lowercase()
            .contains(&normalized(expected).to_lowercase())
    }
}
