export const hostCsp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export function gameCsp(base: string): string {
  return [
    "sandbox allow-scripts",
    "default-src 'none'",
    `script-src ${base} 'wasm-unsafe-eval'`,
    `style-src ${base} 'unsafe-inline'`,
    `img-src ${base} data: blob:`,
    `media-src ${base} data: blob:`,
    `font-src ${base} data:`,
    `connect-src ${base} data: blob:`,
    `worker-src ${base} blob:`,
    "frame-src 'none'",
    "object-src 'none'",
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "webrtc 'block'",
  ].join("; ");
}

export const injectFile = "__gamehearth-dev.js";

export function injectScript(html: string): string {
  const tag = `<script src="./${injectFile}"></script>`;
  const head = /<head[^>]*>/i.exec(html);
  if (head !== null) {
    return `${html.slice(0, head.index + head[0].length)}\n    ${tag}${html.slice(head.index + head[0].length)}`;
  }
  return `${tag}\n${html}`;
}

export const hostHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gamehearth dev</title>
<style>
:root { color-scheme: light dark; --bg: #f4f2ee; --panel: #ffffff; --text: #1f2329; --muted: #646b75; --line: #d9d5ce; --accent: #2f6fd6; --error: #b3261e; --error-bg: #fbe9e7; --warn: #8a5a00; }
@media (prefers-color-scheme: dark) { :root { --bg: #16181c; --panel: #1f2227; --text: #e8e6e3; --muted: #9aa1ab; --line: #343840; --accent: #7aa7ff; --error: #ff8a80; --error-bg: #3a1f1d; --warn: #f0c060; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
header { position: sticky; top: 0; z-index: 2; display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; padding: 10px 16px; background: var(--panel); border-bottom: 1px solid var(--line); }
header h1 { margin: 0; font-size: 16px; }
header .tag { color: var(--muted); }
header .spacer { flex: 1; }
#options { display: flex; flex-wrap: wrap; gap: 8px 12px; }
#options[hidden], body.single #options, body.solo #options { display: none; }
#options label { color: var(--muted); }
button, select { font: inherit; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); color: var(--text); cursor: pointer; }
#status { color: var(--muted); }
#problems { padding: 8px 16px 0; display: grid; gap: 8px; }
.problem { position: relative; border: 1px solid var(--error); background: var(--error-bg); border-radius: 8px; padding: 10px 12px; }
.problem pre { margin: 0; white-space: pre-wrap; word-break: break-word; font: 13px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace; color: var(--text); padding-right: 80px; }
.problem button { position: absolute; top: 8px; right: 8px; }
#note { margin: 8px 16px 0; color: var(--muted); }
#seats { display: flex; flex-wrap: wrap; gap: 16px; padding: 16px; align-items: flex-start; }
.seat { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; width: 362px; }
.bar { display: flex; gap: 12px; align-items: center; padding: 6px 10px; border-bottom: 1px solid var(--line); }
.bar strong { flex: 1; }
.bar a { color: var(--accent); }
.bar .paused { color: var(--error); }
.seat.away .frame { opacity: 0.35; filter: grayscale(0.6); }
.frame { width: 360px; height: 640px; background: var(--panel); }
.seat.tv { width: 642px; }
.seat.tv .frame { width: 640px; height: 360px; }
.frame iframe { width: 100%; height: 100%; border: 0; display: block; }
.placeholder { color: var(--muted); padding: 24px; margin: 0; background: var(--panel); height: 100%; }
details { border-top: 1px solid var(--line); }
summary { cursor: pointer; padding: 6px 10px; color: var(--muted); }
.json { margin: 0; padding: 8px 10px; max-height: 320px; overflow: auto; font: 12px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace; }
.profile-box { padding: 0 10px 8px; }
.profile-box textarea { display: block; box-sizing: border-box; width: 100%; min-height: 110px; margin: 6px 0; resize: vertical; }
.profile-box .profile-note { margin-left: 8px; color: var(--muted); }
#inside { margin: 0 16px 16px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; }
#inside p { margin: 8px 10px; color: var(--muted); }
#inside ol { margin: 0; padding: 8px 10px 8px 40px; max-height: 240px; overflow: auto; font: 12px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace; }
#log-box { margin: 0 16px 16px; }
#logs { margin: 0; padding: 8px 10px 8px 28px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; font: 12px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace; }
#logs .error { color: var(--error); }
#logs .warn { color: var(--warn); }
body.single header .multi, body.single #inside, body.single #log-box { display: none; }
body.single { height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
body.single #seats { padding: 0; flex: 1; min-height: 0; flex-wrap: nowrap; }
body.single .seat, body.single .seat.tv { width: 100%; border: 0; border-radius: 0; display: flex; flex-direction: column; height: 100%; }
body.single .frame, body.single .seat.tv .frame { width: 100%; height: auto; flex: 1; min-height: 0; }
body.single .seat details { display: none; }
body.solo header .multi, body.solo #inside { display: none; }
.seat.solo-medium { width: 802px; }
.seat.solo-medium .frame { width: 800px; height: 500px; }
.seat.solo-large { width: 962px; }
.seat.solo-large .frame { width: 960px; height: 600px; }
#solo-box { margin: 0 16px 16px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; }
#solo-box h2 { font-size: 14px; margin: 8px 0 4px; }
#solo-box p { margin: 6px 0; color: var(--muted); }
#solo-box .actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0; }
body.single #solo-box { display: none; }
</style>
</head>
<body>
<header>
  <h1 id="game-name">Game</h1>
  <span class="tag">Gamehearth dev</span>
  <span class="spacer"></span>
  <span id="status">connecting …</span>
  <span id="sound-note" class="tag" aria-live="polite"></span>
  <label id="sound-box" title="Plays the sounds of the game (game.sound) like the platform: off by default, and on iPhones only with the ringer on"><input type="checkbox" id="sound"> Sound</label>
  <button id="pause" type="button" class="multi" hidden>Pause</button>
  <button id="step" type="button" class="multi" hidden>One tick</button>
  <select id="speed" class="multi" aria-label="Speed" hidden><option value="1">normal</option><option value="0.5">half speed</option><option value="0.25">quarter speed</option></select>
  <select id="language" aria-label="Language" hidden></select>
  <span id="options" hidden></span>
  <select id="count" class="multi" aria-label="Player count"></select>
  <button id="new" type="button" class="multi">New match</button>
</header>
<div id="problems" hidden></div>
<p id="note" hidden></p>
<main id="seats"></main>
<section id="inside">
  <details id="state-box"><summary>Whole state (with secret)</summary><pre id="state" class="json"></pre></details>
  <details><summary>Moves (in realtime the last inputs)</summary><ol id="moves"></ol></details>
  <p>Seed: <code id="seed"></code></p>
</section>
<section id="solo-box" hidden>
  <div class="actions"><button id="solo-reload" type="button">Reload</button><button id="solo-clear-save" type="button">Delete save</button><button id="solo-clear-best" type="button">Delete best scores</button></div>
  <h2>Save</h2>
  <pre id="solo-saved" class="json"></pre>
  <h2>Best scores</h2>
  <pre id="solo-best" class="json"></pre>
  <p>Both are in <code id="solo-file"></code> in the game folder. Edit the file to jump straight to a certain point, then reload the game.</p>
</section>
<section id="log-box" hidden>
  <ul id="logs"></ul>
</section>
<script src="/__dev/host.js"></script>
</body>
</html>
`;
