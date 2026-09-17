// Generated data is inserted inside the component because Mintlify evaluates
// custom component exports independently and does not resolve nested imports.
export const ProductFigure = ({ scene, label, locale = "en" }) => {
  const captures = __CAPTURE_PAYLOADS__;
  const styles = "__CAPTURE_STYLES__";
  const restoreScroll = "__CAPTURE_RESTORE__";
  // Coordinates refer to the real 1344 × 822 app capture, before any scaling.
  const composition = {
    workspace: ["11", "window", 0, 0, 1344, 822],
    "new-agent": ["02", "window", 352, 243, 640, 336],
    github: ["03", "crop", 52, 44, 1020, 640],
    arrangement: ["04", "crop", 338, 43, 1000, 775],
    desktops: ["05", "crop", 0, 0, 1344, 822],
    settings: ["06", "crop", 132, 58, 1079, 706],
    onboarding: ["07", "window", 365, 426, 953, 381],
    "diff-review": ["08", "crop", 56, 47, 1279, 660],
    "review-comment": ["09", "window", 56, 47, 1279, 766],
    ssh: ["10", "window", 842, 47, 493, 331],
    terminal: ["01", "spotlight", 342, 45, 497, 400],
    codex: ["12", "spotlight", 342, 45, 870, 650],
    claude: ["02", "spotlight", 342, 45, 870, 680],
    pi: ["03", "spotlight", 342, 45, 870, 470],
  }[scene];
  const [background, layout, cropX, cropY, cropWidth, cropHeight] = composition;
  const frame = scene === "desktops" ? { left: 0, top: 72, width: 1370, bottom: 0 } : {
    window: { left: 88, top: 88, width: 1324, bottom: 88 },
    crop: { left: 72, top: 72, width: 1356, bottom: 0 },
    spotlight: { left: 160, top: 96, width: 1340, bottom: 0 },
  }[layout];
  const zoom = frame.width / cropWidth;
  const stageHeight = Math.max(layout === "crop" ? 0 : 790, cropHeight * zoom + frame.top + frame.bottom);
  const windowTop = layout === "window" ? (stageHeight - cropHeight * zoom) / 2 : frame.top;
  const example = { en: "Illustrative workspace", ko: "예시 작업 화면", cn: "示例工作区", jp: "ワークスペースの例" }[locale];
  const errorLabel = { en: "Workspace preview could not load.", ko: "작업 화면을 불러오지 못했습니다.", cn: "无法加载工作区预览。", jp: "ワークスペースを読み込めませんでした。" }[locale];
  const host = useRef(null);
  const [width, setWidth] = useState(0);
  const [dark, setDark] = useState(false);
  const [capture, setCapture] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const resize = new ResizeObserver(entries => setWidth(entries[0].contentRect.width));
    resize.observe(host.current);
    const updateTheme = () => setDark(document.documentElement.classList.contains("dark"));
    const theme = new MutationObserver(updateTheme);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    updateTheme();
    return () => { resize.disconnect(); theme.disconnect(); };
  }, []);
  const payload = captures[scene][dark ? "dark" : "light"];
  useEffect(() => {
    let active = true;
    const unpack = async value => {
      const bytes = Uint8Array.from(atob(value), character => character.charCodeAt(0));
      return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
    };
    setFailed(false);
    Promise.all([unpack(payload), unpack(styles)]).then(([json, css]) => {
      if (active) setCapture({ ...JSON.parse(json), css });
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [payload, styles]);
  // The browser capture has no native material. Reveal the outer wallpaper
  // through the app's shell tint, while keeping its reading surfaces opaque.
  const material = ["workspace", "github", "desktops"].includes(scene) ? ";background-color:transparent;--surface-alpha:100%" : "";
  const html = capture ? `<!doctype html><html lang="en" class="${capture.htmlClass}" style="${capture.htmlStyle}${material}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'sha256-__CAPTURE_RESTORE_HASH__'"><style>${capture.css}</style></head><body inert class="${capture.bodyClass}" style="${capture.bodyStyle}">${capture.body}<script>${restoreScroll}</script></body></html>` : "";
  return (
    <div className="dure-figure not-prose" data-scene={scene} data-layout={layout} role="img" aria-label={`${label} ${example}.`}>
      <div className="dure-figure-viewport" ref={host} aria-hidden="true" style={{ aspectRatio: `1500 / ${stageHeight}` }}>
        <div className="dure-figure-stage" data-background={background} style={{ width: 1500, height: stageHeight, transform: `scale(${width / 1500})` }}>
          <img className="dure-figure-wallpaper" src={`/images/gradients/brix-${background}.png`} alt="" />
          <div className="dure-figure-window" data-crop={composition.slice(2).join(",")} style={{ left: frame.left, top: windowTop, width: frame.width, height: cropHeight * zoom }}>
            {capture && !failed && <iframe title={label} sandbox="allow-scripts" tabIndex={-1} srcDoc={html} style={{ left: -cropX * zoom, top: -cropY * zoom, transform: `scale(${zoom})` }} />}
          </div>
        </div>
        {failed && <div className="dure-figure-error">{errorLabel}</div>}
      </div>
      <div className="dure-figure-example" aria-hidden="true">{example}</div>
    </div>
  );
};
