import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { productMediaBoundaryViolations } from "./lib/product-media-boundary.mjs";

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-media-boundary-"));
  roots.push(root);
  for (const [relativePath, source] of Object.entries(files)) {
    const absolute = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, source);
  }
  return root;
}

describe("product media architecture boundary", () => {
  it("accepts media tooling that stays outside production roots", () => {
    const root = fixture({
      "docs/public/images/hero.png": "documentation asset\n",
      "tools/media-capture/capture.mjs": 'import "./runtime.mjs";\n',
      "public/readme/hero.txt": "documentation asset\n",
      "src/App.tsx": 'export const App = () => "Dure";\n',
    });
    expect(productMediaBoundaryViolations(root)).toEqual([]);
  });

  it("rejects runtime imports and embedded public media paths", () => {
    const root = fixture({
      "src/App.tsx": 'import "../tools/media-capture/capture.mjs";\n',
      "src/docs.ts": 'export { default as docs } from "../docs/public/docs.json";\n',
      "src-tauri/src/lib.rs": 'const HERO: &str = include_str!("../../public/readme/hero.png");\n',
    });
    expect(productMediaBoundaryViolations(root)).toEqual([
      "productMediaBoundary: src-tauri/src/lib.rs references public/readme",
      "productMediaBoundary: src/App.tsx references tools/media-capture",
      "productMediaBoundary: src/docs.ts references docs/public/",
    ]);
  });

  it("accepts a documentation citation beside a mobile browser link", () => {
    const root = fixture({
      "mobile/src/openExternal.ts": `
        /** The owned site is documented in docs/public/README.md:15-16. */
        export const HELP_URL = "https://dureai.dev/";
      `,
    });
    expect(productMediaBoundaryViolations(root)).toEqual([]);
  });

  it.each([
    ["src/view.ts", "// docs/public/README.md\nexport const ready: boolean = true;"],
    ["src/view.tsx", "export const View = () => <p>{/* public/readme examples */}Ready</p>;"],
    ["src/view.jsx", "/* tools/media-capture examples */ export const View = () => <p>Ready</p>;"],
    ["src/view.js", 'const root = "https://dureai.dev/"; // docs/public/README.md'],
    ["cli/view.mjs", 'export const path = `${root /* docs/public/README.md */}/help`;'],
    ["src-tauri/src/lib.rs", "/// docs/public/README.md\nfn ready() {} // public/readme examples"],
    ["crates/demo/src/lib.rs", "/* outer /* tools/media-capture */ docs/public/README.md */ fn ready() {}"],
    ["index.html", '<!-- docs/public/README.md --><a href="https://dureai.dev/">Help</a>'],
    ["src/page.html", '<script>const path = "https://dureai.dev/"; // docs/public/README.md\n</script><style>/* public/readme examples */ p { color: red; }</style>'],
    ["crates/demo/Cargo.toml", '# docs/public/README.md\nname = "demo" # tools/media-capture examples'],
    ["src/config.toml", String.raw`path = 'C:\' # docs/public/README.md`],
    ["src/config.toml", String.raw`path = '''C:\''' # docs/public/README.md`],
    ["src/config.toml", 'count = 9223372036854775807 # docs/public/README.md'],
    ["src/config.toml", 'value = """two quotes: """"" # docs/public/README.md'],
  ])("ignores non-executable comments in %s", (file, source) => {
    expect(productMediaBoundaryViolations(fixture({ [file]: source }))).toEqual([]);
  });

  it.each([
    ["src/view.ts", 'const ref = "//docs/public/file";'],
    ["src/view.ts", 'const ref = "/* docs/public/file */";'],
    ["src/view.js", 'const ref = "escaped quote \\" //docs/public/file";'],
    ["cli/view.mjs", 'const ref = `//docs/public/${file}`;'],
    ["src/view.ts", 'const ref = `${root}/docs/public/${file}`;'],
    ["src/view.ts", 'const ref = `${root}/docs/public/file`;'],
    ["src/view.ts", 'const ref = `${flag ? "safe" : `/${"docs/public/file"}`}`;'],
    ["src/view.ts", 'const ref = import(/* docs/public/README.md */ "../docs/public/file");'],
    ["src/view.tsx", "export const View = () => <p>/* docs/public/file */</p>;"],
    ["src/view.jsx", 'export const View = () => <img src="//docs/public/file" />;'],
    ["src-tauri/src/lib.rs", 'const PATH: &str = r###"/* docs/public/file */"###;'],
    ["hmux/crates/demo/src/lib.rs", 'const PATH: &[u8] = br##"//docs/public/file"##;'],
    ["crates/demo/src/lib.rs", '#[doc = include_str!("../docs/public/file")] fn ready() {}'],
    ["src/config.json", '{"path":"//docs/public/file"}'],
    ["src/config.toml", 'path = "https://dureai.dev/#docs/public/file"'],
    ["src/config.toml", "path = '#docs/public/file'"],
    ["src/config.toml", 'path = """\n# docs/public/file\n"""'],
    ["src/config.toml", "path = '''\n# docs/public/file\n'''"],
    ["src/config.toml", String.raw`path = 'C:\'
asset = '#docs/public/file'`],
    ["src/config.toml", '"#docs/public/file" = true'],
    ["index.html", '<img src="<!--docs/public/file-->">'],
    ["src/page.html", '<textarea><!--docs/public/file--></textarea>'],
    ["src/page.html", '<script>const ref = "<!--docs/public/file-->";</script>'],
    ["src/page.html", '<script type="application/json">{"path":"//docs/public/file"}</script>'],
    ["src/page.html", '<style>p { background: url("//docs/public/file"); }</style>'],
  ])("retains embedded references and comment-like literal content in %s: %s", (file, source) => {
    expect(productMediaBoundaryViolations(fixture({ [file]: source }))).toEqual([
      `productMediaBoundary: ${file} references docs/public/`,
    ]);
  });

  it.each([
    '/// <reference path="../docs/public/types.d.ts" />\nexport {};',
    '/** @jsxImportSource ../docs/public/runtime */\nexport const View = () => <p />;',
    '// # sourceMappingURL=../docs/public/view.js.map\nexport {};',
  ])("retains dependency-bearing compiler directives: %s", (source) => {
    expect(productMediaBoundaryViolations(fixture({ "src/view.tsx": source }))).toEqual([
      "productMediaBoundary: src/view.tsx references docs/public/",
    ]);
  });

  it("does not let a citation hide another reference to the same path", () => {
    const root = fixture({
      "src/view.ts": `
        /* See docs/public/README.md for background. */
        export const load = () => import("../docs/public/runtime.mjs");
        // docs/public/README.md
      `,
    });
    expect(productMediaBoundaryViolations(root)).toEqual([
      "productMediaBoundary: src/view.ts references docs/public/",
    ]);
  });
});
