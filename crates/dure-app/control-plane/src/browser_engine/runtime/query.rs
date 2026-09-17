use super::BrowserElementTarget;
use super::locator::BrowserLocator;
use super::observation::{document, url};
use hmux_session_protocol::browser_resource::BrowserElementReference;
use serde::Deserialize;
use serde_json::{Value, json};

/// Fixed observations; arbitrary page evaluation remains a controller action.
#[derive(Debug, Deserialize)]
#[serde(try_from = "Query")]
pub struct BrowserQuery(Query);

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Query {
    Data {
        query: super::data::BrowserDataQuery,
    },
    FindText {
        locator: BrowserLocator,
    },
    Text {
        target: BrowserElementTarget,
    },
    Html {
        target: BrowserElementTarget,
    },
    Value {
        target: BrowserElementTarget,
    },
    Attribute {
        target: BrowserElementTarget,
        name: String,
    },
    Count {
        target: BrowserElementTarget,
    },
    Box {
        target: BrowserElementTarget,
    },
    Styles {
        target: BrowserElementTarget,
    },
    Url,
    Title,
    Visible {
        target: BrowserElementTarget,
    },
    Enabled {
        target: BrowserElementTarget,
    },
    Checked {
        target: BrowserElementTarget,
    },
}

impl TryFrom<Query> for BrowserQuery {
    type Error = &'static str;

    fn try_from(query: Query) -> Result<Self, Self::Error> {
        match &query {
            Query::Attribute { name, .. } if name.is_empty() || name.len() > 1024 => {
                return Err("browser_attribute_invalid");
            }
            // Count selects a set; a snapshot reference names one exact node.
            Query::Count { target } if target.reference().is_some() => {
                return Err("browser_count_requires_selector");
            }
            _ => {}
        }
        Ok(Self(query))
    }
}

impl BrowserQuery {
    pub(super) async fn read(
        &self,
        mut cdp: super::BrowserCdp,
        target: &str,
    ) -> Result<Value, &'static str> {
        let mut value = match &self.0 {
            Query::Data { query } => return query.read(cdp, target).await,
            Query::FindText { locator } => {
                let mut element =
                    super::locator::LocatedElement::resolve(cdp, target, locator).await?;
                return Ok(json!({"text":element.text().await?}));
            }
            Query::Url => return Ok(json!({"url":url(&mut cdp, target).await?})),
            Query::Title | Query::Count { .. } => {
                let expression = if let Query::Count { target } = &self.0 {
                    let selector = target.selector()?;
                    let count = match selector.strip_prefix("xpath=") {
                        Some(xpath) => format!(
                            "document.evaluate({},document,null,XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,null).snapshotLength",
                            json!(xpath)
                        ),
                        None => format!("document.querySelectorAll({}).length", json!(selector)),
                    };
                    format!("({{count:{count},selector:{}}})", json!(selector))
                } else {
                    "({title:document.title})".into()
                };
                document(&mut cdp, target, &expression).await?
            }
            _ => self.read_element(cdp.clone(), target).await?,
        };
        // Preserve the existing CSS query provenance fields without executing
        // page-defined getters just to read the document's origin.
        if self.reference().is_none()
            && matches!(
                self.0,
                Query::Text { .. }
                    | Query::Attribute { .. }
                    | Query::Visible { .. }
                    | Query::Enabled { .. }
                    | Query::Checked { .. }
            )
        {
            value["origin"] = url(&mut cdp, target).await?.into();
        }
        Ok(value)
    }

    async fn read_element(
        &self,
        cdp: super::BrowserCdp,
        target: &str,
    ) -> Result<Value, &'static str> {
        let mut element = self
            .element_target()
            .ok_or("browser_reference_invalid")?
            .resolve(cdp, target)
            .await?;
        let expression = match &self.0 {
            Query::Text { .. } => "({text:this.innerText||this.textContent||''})".into(),
            Query::Html { .. } => "({html:this.innerHTML})".into(),
            Query::Value { .. } => "({value:this.value})".into(),
            Query::Attribute { name, .. } => format!("({{value:this.getAttribute({})}})", json!(name)),
            Query::Box { .. } => "(()=>{const r=this.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()".into(),
            Query::Styles { .. } => "(()=>{const style=getComputedStyle(this);return {styles:Object.fromEntries(Array.from(style,name=>[name,style.getPropertyValue(name)]))};})()".into(),
            Query::Visible { .. } => "(()=>{const rect=this.getBoundingClientRect(),style=getComputedStyle(this);return {visible:rect.width>0&&rect.height>0&&style.visibility!=='hidden'&&style.display!=='none'&&parseFloat(style.opacity)>0};})()".into(),
            Query::Enabled { .. } => "({enabled:!this.matches(':disabled')&&this.getAttribute('aria-disabled')!=='true'})".into(),
            Query::Checked { .. } => "({checked:typeof this.checked==='boolean'?this.checked:this.getAttribute('aria-checked')==='true'})".into(),
            _ => return Err("browser_reference_invalid"),
        };
        element
            .call(&format!(
                "function(){{if(!this.isConnected)throw Error();return {expression};}}"
            ))
            .await
    }
    pub(super) fn reference(&self) -> Option<&BrowserElementReference> {
        self.element_target()
            .and_then(BrowserElementTarget::reference)
    }

    fn element_target(&self) -> Option<&BrowserElementTarget> {
        match &self.0 {
            Query::Text { target }
            | Query::Html { target }
            | Query::Value { target }
            | Query::Attribute { target, .. }
            | Query::Count { target }
            | Query::Box { target }
            | Query::Styles { target }
            | Query::Visible { target }
            | Query::Enabled { target }
            | Query::Checked { target } => Some(target),
            Query::Url | Query::Title | Query::FindText { .. } | Query::Data { .. } => None,
        }
    }
}
