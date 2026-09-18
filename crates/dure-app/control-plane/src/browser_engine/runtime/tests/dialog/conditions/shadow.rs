use super::*;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn text_wait_observes_open_shadow_roots_without_page_getters() {
    let (runtime, identity, root) = super::super::authority::launch("wait:shadow").await;
    let evidence: Result<_, BrowserRuntimeError> = async {
        let page = first_page(&runtime).await?;
        let lease = runtime.request_control(BrowserControllerId::new("agent").unwrap(), None).await?.controller.unwrap();
        apply(&runtime, &lease, &page, json!({"kind":"evaluate","script":r#"
document.body.innerHTML='<p>Ordinary text</p><div id=host></div><div id=hidden hidden></div><div id=direct></div>';
const shadow=document.querySelector('#host').attachShadow({mode:'open'});
shadow.innerHTML='<button>Shadow complete 한글</button><div id=nested></div><p hidden>Hidden child</p><p style="visibility:hidden">Invisible child</p><div style="display:contents">Display contents</div><span>Inline</span> text<p>Block one</p><p>Block two</p>';
shadow.querySelector('#nested').attachShadow({mode:'open'}).innerHTML='<span>Nested text</span>';
document.querySelector('#hidden').attachShadow({mode:'open'}).innerHTML='<p>Hidden host</p>';
document.querySelector('#direct').attachShadow({mode:'open'}).append('Direct shadow text');
window.waitCalls=[];
for(const [owner,key] of [[Element.prototype,'shadowRoot'],[Element.prototype,'children'],[Node.prototype,'childNodes'],[HTMLElement.prototype,'innerText']]) {
  const descriptor=Object.getOwnPropertyDescriptor(owner,key);
  Object.defineProperty(owner,key,{...descriptor,get(){waitCalls.push(key);return descriptor.get.call(this)}});
}
true
"#})).await?;
        let before = runtime.control().await;
        let mut results = Vec::new();
        for (text, expected) in [
            ("Ordinary text", true), ("Shadow complete 한글", true),
            ("Nested text", true), ("Direct shadow text", true),
            ("Display contents", true), ("Inline text", true),
            ("Block oneBlock two", false),
            ("Hidden child", false), ("Invisible child", false),
            ("Hidden host", false), ("');window.waitCalls.push('injected');//", false),
        ] {
            let result = runtime.wait(&page, &serde_json::from_value(json!({"condition":{"kind":"text","text":text},"timeout_ms":0})).unwrap()).await;
            results.push((text, expected, result));
        }
        let after = runtime.control().await;
        let calls = apply(&runtime, &lease, &page, json!({"kind":"evaluate","script":"waitCalls"})).await?;
        Ok((results, before, after, calls))
    }.await;
    let retired = runtime.close(&identity).await;
    println!(
        "BROWSER_WAIT_SHADOW root={} evidence={evidence:?} retired={retired:?}",
        root.display()
    );
    assert!(retired.is_ok(), "{retired:?}");
    let (results, before, after, calls) = evidence.unwrap();
    for (text, expected, result) in results {
        if expected {
            assert_eq!(result.unwrap()["waited"], true, "{text}");
        } else {
            assert!(
                matches!(
                    result,
                    Err(BrowserRuntimeError::Observation("browser_wait_timeout"))
                ),
                "{text}: {result:?}"
            );
        }
    }
    assert_eq!(before, after);
    assert_eq!(calls["result"], json!([]));
}
