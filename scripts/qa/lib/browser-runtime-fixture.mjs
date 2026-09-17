import { createServer } from "node:http";
import { once } from "node:events";

const page = `<!doctype html><html lang="en"><meta charset="utf-8">
<title>Dure Browser Runtime Fixture</title>
<style>body{font:20px system-ui;margin:32px;background:#fafafa;color:#222}input,button{font:inherit;padding:12px;margin:8px 0}label{display:block}output{display:block;padding:24px;background:#e5e5e5;min-height:60px}button{display:block}iframe{margin-top:20px}</style>
<h1>Dure Browser Runtime Fixture</h1><p id="identity"></p>
<form><label>Name<input name="name" aria-label="Name" autocomplete="off"></label>
<button type="submit">Apply</button></form><output aria-live="polite">Ready</output>
<label>Rich text<div contenteditable="true" role="textbox" aria-label="Rich text">Initial</div></label>
<a href="/next">Next page</a><div id="shadow"></div><iframe title="Child frame" src="/frame"></iframe>
<script>
const owner = new URL(location.href).searchParams.get('owner') || 'none';
const instance = crypto.randomUUID();
localStorage.setItem('owner', owner); document.cookie = 'owner=' + owner + ';path=/;SameSite=Strict';
document.querySelector('#identity').textContent = 'Owner: ' + owner + ' / instance: ' + instance;
window.fixture = {owner, instance, submissions:0};
const root = document.querySelector('#shadow').attachShadow({mode:'open'});
root.innerHTML = '<button type="button">Shadow action</button>';
root.querySelector('button').onclick = () => root.querySelector('button').textContent='Shadow complete';
document.querySelector('form').onsubmit = async (event) => {
 event.preventDefault();
 const value = document.querySelector('input').value;
 const data = await fetch('/submit', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({owner,instance,value})}).then(r=>r.json());
 window.fixture.submissions++;
 document.querySelector('output').textContent = 'Saved: ' + value + ' (' + data.count + ')';
 document.querySelector('output').style.background = '#bdd9c5';
 console.log('fixture-saved', window.fixture.submissions);
};
</script></html>`;

export async function startBrowserRuntimeFixture() {
  const submissions = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/submit" && request.method === "POST") {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 16_384) {
          response.writeHead(413).end();
          return;
        }
      }
      const parsed = JSON.parse(body);
      submissions.push({ ...parsed, cookie: request.headers.cookie ?? "" });
      response
        .writeHead(200, { "Content-Type": "application/json" })
        .end(
          JSON.stringify({
            count: submissions.filter((v) => v.instance === parsed.instance)
              .length,
          }),
        );
      return;
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setHeader("X-Frame-Options", "SAMEORIGIN");
    if (url.pathname === "/frame") {
      response.end(
        "<button onclick=\"this.textContent='Frame complete'\">Frame action</button>",
      );
    } else if (url.pathname === "/next") {
      response.end(
        "<h1>Next page</h1><button onclick=\"this.dataset.clicked='yes'\">Different target</button>",
      );
    } else {
      response.end(page);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    submissions,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
