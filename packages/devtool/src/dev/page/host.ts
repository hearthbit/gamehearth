import { bridgeVersion, createMusicPlayer, localize, parseGameMessage, type Localized, type MoveResult, type MusicTrack, type Sound } from "@gamehearth/sdk/platform";
import {
  admitSound,
  formatProblem,
  frameSnapshot,
  frameUpdate,
  musicLabel,
  musicSource,
  screenSeat,
  settingsMessage,
  soloMessage,
  soundLabel,
  soundPlan,
  type DevLog,
  type DevProblem,
  type DevView,
  type SeatView,
} from "../view";

interface Frame {
  seat: string;
  screen: boolean;
  root: HTMLElement;
  iframe: HTMLIFrameElement | undefined;
  holder: HTMLElement;
  bot: HTMLInputElement | undefined;
  botState: HTMLElement | undefined;
  away?: HTMLInputElement;
  sounds: number[];
  track: MusicTrack | null;
  details: HTMLDetailsElement;
  snapshot: HTMLElement;
  ready: boolean;
  sent: string | undefined;
  profile?: { box: HTMLDetailsElement; summary: HTMLElement; text: HTMLTextAreaElement; guest: HTMLInputElement; note: HTMLElement; dirty: boolean; shown: string; latest: string };
}

const soloOnlyText = "This game is a single-player game without a reducer (mode \"single\", server false). It calls connectSolo() from @gamehearth/sdk/client, not connect().";
const noSoloText = "This game has a reducer and runs like in a room. connectSolo() only exists for single-player games without a reducer (mode \"single\", server false); games with a reducer call connect().";
const single = /^\/(p\d+|tv)\/?$/.exec(location.pathname)?.[1];
const frames = new Map<string, Frame>();
let view: DevView | undefined;
let layoutKey = "";
const soundKey = "gamehearth-dev.sound";
const musicKey = "gamehearth-dev.music";
let soundOn = readSetting(soundKey);
let musicOn = readSetting(musicKey);
let audio: AudioContext | undefined;
const player = createMusicPlayer({ context: () => audioContext() });

function readSetting(key: string): boolean {
  try {
    return localStorage.getItem(key) === "on";
  } catch {
    return false;
  }
}

function storeSetting(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? "on" : "off");
  } catch {
    return;
  }
}

function audioContext(): AudioContext | undefined {
  if (audio !== undefined) {
    return audio;
  }
  const scope = globalThis as { AudioContext?: new () => AudioContext; webkitAudioContext?: new () => AudioContext };
  const Audio = scope.AudioContext ?? scope.webkitAudioContext;
  if (Audio === undefined) {
    return undefined;
  }
  try {
    audio = new Audio();
  } catch {
    return undefined;
  }
  return audio;
}

function unlockSound(): void {
  const context = soundOn ? audioContext() : undefined;
  if (context?.state === "suspended") {
    void context.resume().catch(() => undefined);
  }
}

function playSound(frame: Frame, sound: Sound): void {
  if (!soundOn || !admitSound(frame.sounds, performance.now())) {
    return;
  }
  byId("sound-note").textContent = `♪ ${frame.screen ? "TV" : frame.seat}: ${soundLabel(sound)}`;
  const context = audioContext();
  if (context === undefined) {
    return;
  }
  unlockSound();
  for (const tone of soundPlan(sound, context.currentTime + 0.01)) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = tone.wave;
    oscillator.frequency.setValueAtTime(tone.from, tone.begin);
    if (tone.to !== undefined) {
      oscillator.frequency.exponentialRampToValueAtTime(tone.to, tone.end);
    }
    gain.gain.setValueAtTime(0.0001, tone.begin);
    gain.gain.exponentialRampToValueAtTime(Math.max(tone.peak, 0.0001), tone.begin + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, tone.end);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(tone.begin);
    oscillator.stop(tone.end + 0.02);
  }
}

function refreshMusic(): void {
  const track = soundOn && musicOn ? (musicSource(frames.values())?.track ?? null) : null;
  const hidden = document.visibilityState === "hidden";
  if (track !== null && !hidden) {
    unlockSound();
  }
  player.setPaused(hidden);
  player.play(track);
  byId("music-note").textContent = musicLabel(hidden ? null : track);
}

function sendSettings(frame: Frame): void {
  frame.iframe?.contentWindow?.postMessage(settingsMessage(soundOn, musicOn), "*");
}

function sendAllSettings(): void {
  for (const frame of frames.values()) {
    if (frame.ready) {
      sendSettings(frame);
    }
  }
  refreshMusic();
}

function setSound(on: boolean): void {
  soundOn = on;
  storeSetting(soundKey, on);
  unlockSound();
  byId("sound-note").textContent = "";
  sendAllSettings();
}

function setMusic(on: boolean): void {
  musicOn = on;
  storeSetting(musicKey, on);
  unlockSound();
  sendAllSettings();
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) {
    throw new Error(`#${id} is missing`);
  }
  return node as T;
}

async function post(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return response.json();
}

function hasScreen(current: DevView): boolean {
  return current.game?.roles.includes("screen") === true;
}

function text(value: Localized): string {
  return localize(value, view?.language);
}

function languageName(code: string): string {
  try {
    const name = new Intl.DisplayNames(["en"], { type: "language" }).of(code);
    return name === undefined || name === code ? code : `${name} (${code})`;
  } catch {
    return code;
  }
}

function sendUpdate(frame: Frame): void {
  const current = view;
  const update = current === undefined ? undefined : frameUpdate(current, frame.seat);
  if (!frame.ready || update === undefined || frame.iframe?.contentWindow == null) {
    return;
  }
  const serialized = JSON.stringify(update);
  if (serialized === frame.sent) {
    return;
  }
  frame.sent = serialized;
  frame.iframe.contentWindow.postMessage(update, "*");
}

function loadFrame(frame: Frame): void {
  const current = view;
  frame.ready = false;
  frame.sent = undefined;
  frame.sounds = [];
  frame.track = null;
  refreshMusic();
  frame.iframe?.remove();
  frame.iframe = undefined;
  frame.holder.replaceChildren();
  if (current === undefined || !current.client.ready) {
    frame.holder.append(element("p", { className: "placeholder" }, current?.client.note ?? "Building the UI …"));
    return;
  }
  if (frameSnapshot(current, frame.seat) === undefined) {
    frame.holder.append(element("p", { className: "placeholder" }, "No match. The error is shown above."));
    return;
  }
  const iframe = element("iframe", { title: frame.screen ? "Game on the TV" : `Game for ${frame.seat}` });
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.src = `/game/index.html?seat=${frame.seat}&v=${current.client.version}`;
  frame.iframe = iframe;
  frame.holder.append(iframe);
}

function buildScreenFrame(root: HTMLElement): void {
  const snapshot = element("pre", { className: "json" });
  const holder = element("div", { className: "frame" });
  const bar = element(
    "div",
    { className: "bar" },
    element("strong", {}, "TV"),
    single === undefined ? element("a", { href: "/tv", target: "_blank" }, "own window") : element("a", { href: "/" }, "all seats"),
  );
  const details = element("details", {}, element("summary", {}, "Snapshot of the TV"), snapshot);
  details.addEventListener("toggle", refreshInsight);
  const article = element("article", { className: "seat tv" }, bar, holder, details);
  root.append(article);
  const frame: Frame = { seat: screenSeat, screen: true, root: article, iframe: undefined, holder, bot: undefined, botState: undefined, sounds: [], track: null, details, snapshot, ready: false, sent: undefined };
  frames.set(screenSeat, frame);
  loadFrame(frame);
}

function buildSoloFrame(current: DevView, root: HTMLElement): void {
  const holder = element("div", { className: "frame" });
  const bar = element(
    "div",
    { className: "bar" },
    element("strong", {}, "Single player"),
    single === undefined ? element("a", { href: "/p1", target: "_blank" }, "own window") : element("a", { href: "/" }, "with insight"),
  );
  const snapshot = element("pre", { className: "json" });
  const details = element("details", {}, snapshot);
  const article = element("article", { className: `seat solo-${current.solo?.screen ?? "small"}` }, bar, holder);
  root.append(article);
  const frame: Frame = { seat: "p1", screen: false, root: article, iframe: undefined, holder, bot: undefined, botState: undefined, sounds: [], track: null, details, snapshot, ready: false, sent: undefined };
  frames.set("p1", frame);
  loadFrame(frame);
}

function buildFrames(current: DevView): void {
  const seats = current.session.seats.filter((entry) => single === undefined || entry.seat === single);
  const root = byId("seats");
  frames.clear();
  root.replaceChildren();
  refreshMusic();
  if (current.solo !== undefined) {
    buildSoloFrame(current, root);
    return;
  }
  const screen = hasScreen(current) && (single === undefined || single === screenSeat);
  if (screen) {
    buildScreenFrame(root);
  }
  if (single !== undefined && seats.length === 0 && !screen) {
    root.append(element("p", { className: "placeholder" }, `The seat ${single} does not exist in this match. `, element("a", { href: "/" }, "All seats")));
    return;
  }
  for (const entry of seats) {
    const bot = element("input", { type: "checkbox", checked: entry.bot });
    bot.addEventListener("change", () => void post("/__dev/bot", { seat: entry.seat, on: bot.checked }));
    const playOn = current.game?.away === "play-on" && current.session.realtime !== undefined;
    const away = playOn ? element("input", { type: "checkbox", checked: entry.away }) : undefined;
    away?.addEventListener("change", () => void post("/__dev/away", { seat: entry.seat, on: away.checked }));
    const snapshot = element("pre", { className: "json" });
    const holder = element("div", { className: "frame" });
    const botState = element("span", { className: "paused" });
    const bar = element(
      "div",
      { className: "bar" },
      element("strong", {}, `${entry.seat} · ${entry.name}`),
      element("label", {}, bot, " Bot", botState),
      ...(away === undefined ? [] : [element("label", { title: "The seat counts as away (ctx.away), like a locked phone in a game that plays on" }, away, " Away")]),
      single === undefined ? element("a", { href: `/${entry.seat}`, target: "_blank" }, "own window") : element("a", { href: "/" }, "all seats"),
    );
    const details = element("details", {}, element("summary", {}, `Snapshot of ${entry.seat}`), snapshot);
    details.addEventListener("toggle", refreshInsight);
    const profile = buildProfileBox(entry);
    profile.box.hidden = view?.game?.profiles !== true;
    const article = element("article", { className: "seat" }, bar, holder, details, profile.box);
    root.append(article);
    const frame: Frame = {
      seat: entry.seat,
      screen: false,
      root: article,
      iframe: undefined,
      holder,
      bot,
      botState,
      ...(away === undefined ? {} : { away }),
      sounds: [],
      track: null,
      details,
      snapshot,
      ready: false,
      sent: undefined,
      profile,
    };
    frames.set(entry.seat, frame);
    loadFrame(frame);
  }
}

function buildProfileBox(entry: SeatView): NonNullable<Frame["profile"]> {
  const summary = element("summary", {}, `Profile of ${entry.seat}`);
  const text = element("textarea", { className: "json", spellcheck: false });
  text.setAttribute("aria-label", `Profile of ${entry.seat} as JSON`);
  const guest = element("input", { type: "checkbox", checked: entry.guest });
  const note = element("span", { className: "profile-note" });
  const apply = element("button", { type: "button", textContent: "Apply" });
  const discard = element("button", { type: "button", textContent: "Discard" });
  const box = element(
    "details",
    { className: "profile-box" },
    summary,
    element("label", {}, guest, " Guest: plays with an empty profile that is dropped after the match (starts a new match)"),
    text,
    element("div", {}, apply, " ", discard, note),
  );
  const current = JSON.stringify(entry.profile, null, 2);
  const state = { box, summary, text, guest, note, dirty: false, shown: current, latest: current };
  text.value = current;
  text.addEventListener("input", () => {
    state.dirty = true;
    note.textContent = state.latest === state.shown ? "" : changedNote;
  });
  discard.addEventListener("click", () => {
    text.value = state.latest;
    state.shown = state.latest;
    state.dirty = false;
    note.textContent = "";
  });
  apply.addEventListener("click", () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.value);
    } catch (error) {
      note.textContent = `Not valid JSON: ${error instanceof Error ? error.message : String(error)}`;
      return;
    }
    void (post("/__dev/profile", { seat: entry.seat, profile: parsed }) as Promise<MoveResult>).then((answer) => {
      note.textContent = answer.ok ? "applied" : answer.message;
      if (answer.ok) {
        state.dirty = false;
      }
    });
  });
  guest.addEventListener("change", () => {
    const wanted = guest.checked;
    void (post("/__dev/guest", { seat: entry.seat, guest: wanted }) as Promise<MoveResult>).then((answer) => {
      if (!answer.ok) {
        guest.checked = !wanted;
        note.textContent = answer.message;
      }
    });
  });
  return state;
}

const changedNote = 'The profile has changed in the meantime. "Apply" sets your text, "Discard" fetches the current state.';

function renderProfile(frame: Frame, entry: SeatView): void {
  const profile = frame.profile;
  if (profile === undefined) {
    return;
  }
  profile.guest.checked = entry.guest;
  profile.summary.textContent = `Profile of ${entry.seat}${entry.guest ? " (guest)" : ""}`;
  profile.latest = JSON.stringify(entry.profile, null, 2);
  if (!profile.dirty && document.activeElement !== profile.text) {
    profile.text.value = profile.latest;
    profile.shown = profile.latest;
  } else if (profile.latest !== profile.shown) {
    profile.note.textContent = changedNote;
  }
}

function renderProblems(current: DevView): void {
  const problems: DevProblem[] = [...(current.session.problem === undefined ? [] : [current.session.problem]), ...current.session.botProblems, ...current.problems];
  const box = byId("problems");
  box.replaceChildren(
    ...problems.map((problem) => {
      const text = formatProblem(problem);
      const copy = element("button", { type: "button", textContent: "Copy" });
      copy.addEventListener("click", () => {
        void navigator.clipboard?.writeText(text).then(() => {
          copy.textContent = "Copied";
        });
      });
      return element("section", { className: `problem ${problem.source}` }, element("pre", {}, text), copy);
    }),
  );
  box.hidden = problems.length === 0;
  const note = byId("note");
  note.textContent = current.session.note ?? "";
  note.hidden = current.session.note === undefined;
}

function renderLogs(logs: DevLog[]): void {
  const list = byId("logs");
  list.replaceChildren(...logs.map((log) => element("li", { className: log.level }, `${log.seat} ${log.level}: ${log.text}`)));
  byId("log-box").hidden = logs.length === 0;
}

function renderOptions(current: DevView): void {
  const holder = byId("options");
  const spec = current.solo === undefined ? (current.game?.options ?? {}) : {};
  const shape = JSON.stringify([spec, current.language]);
  if (holder.dataset["spec"] !== shape) {
    holder.dataset["spec"] = shape;
    holder.replaceChildren(
      ...Object.entries(spec).map(([name, option]) => {
        const choices =
          option.type === "boolean"
            ? [
                { value: "true", label: "yes" },
                { value: "false", label: "no" },
              ]
            : option.choices.map((choice) => ({ value: String(choice.value), label: text(choice.label) }));
        const select = element("select", { className: "multi" }, ...choices.map((choice) => element("option", { value: choice.value, textContent: choice.label })));
        select.dataset["option"] = name;
        select.setAttribute("aria-label", text(option.label));
        select.addEventListener("change", () => {
          const picked = option.type === "boolean" ? select.value === "true" : option.choices.find((choice) => String(choice.value) === select.value)?.value;
          void post("/__dev/new", { playerCount: Number(byId<HTMLSelectElement>("count").value), options: { [name]: picked } });
        });
        return element("label", { className: "option" }, `${text(option.label)} `, select);
      }),
    );
  }
  holder.hidden = holder.childElementCount === 0;
  for (const select of holder.querySelectorAll<HTMLSelectElement>("select[data-option]")) {
    const value = current.session.options[select.dataset["option"] ?? ""];
    if (document.activeElement !== select && value !== undefined) {
      select.value = String(value);
    }
  }
}

function renderLanguage(current: DevView): void {
  const select = byId<HTMLSelectElement>("language");
  const languages = current.game?.languages ?? [];
  if (languages.join(",") !== [...select.options].map((option) => option.value).join(",")) {
    select.replaceChildren(...languages.map((code) => element("option", { value: code, textContent: languageName(code) })));
  }
  select.hidden = current.game?.languages === undefined;
  if (document.activeElement !== select && current.language !== undefined) {
    select.value = current.language;
  }
}

function renderToolbar(current: DevView): void {
  const name = current.game === undefined ? "Game" : text(current.game.name);
  document.title = `${name} · Gamehearth dev`;
  byId("game-name").textContent = name;
  renderLanguage(current);
  const select = byId<HTMLSelectElement>("count");
  const counts = current.game?.counts ?? [];
  const wanted = String(current.session.playerCount);
  const options = counts.map((count) => String(count));
  if (options.join(",") !== [...select.options].map((option) => option.value).join(",")) {
    select.replaceChildren(...options.map((value) => element("option", { value, textContent: `${value} ${value === "1" ? "player" : "players"}` })));
  }
  if (document.activeElement !== select) {
    select.value = wanted;
  }
  renderOptions(current);
  const session = current.session;
  const realtime = session.realtime;
  if (current.solo !== undefined) {
    byId("status").textContent = "Single player without a reducer";
    return;
  }
  const status =
    session.result !== undefined
      ? "Match over"
      : session.version === undefined
        ? "no match"
        : realtime !== undefined
          ? `Tick ${realtime.tick} (${(realtime.tick / 20).toFixed(1)} s of game time), ${realtime.inputs} ${realtime.inputs === 1 ? "input" : "inputs"}${realtime.running ? "" : ", paused"}`
          : `Version ${session.version}, ${session.moves.length} ${session.moves.length === 1 ? "move" : "moves"}`;
  byId("status").textContent = status;
  for (const id of ["pause", "step", "speed"]) {
    byId(id).hidden = realtime === undefined;
  }
  if (realtime !== undefined) {
    byId("pause").textContent = realtime.running ? "Pause" : "Resume";
    byId<HTMLButtonElement>("step").disabled = realtime.running || session.result !== undefined;
    const speed = byId<HTMLSelectElement>("speed");
    if (document.activeElement !== speed) {
      speed.value = String(realtime.speed);
    }
  }
}

function refreshInsight(): void {
  if (view !== undefined) {
    renderInsight(view);
  }
}

function renderSolo(current: DevView): void {
  const solo = current.solo;
  document.body.classList.toggle("solo", solo !== undefined);
  byId("solo-box").hidden = solo === undefined;
  if (solo === undefined) {
    return;
  }
  byId("solo-saved").textContent = JSON.stringify(solo.saved ?? null, null, 2);
  byId("solo-best").textContent = JSON.stringify(solo.best, null, 2);
  byId("solo-file").textContent = solo.file;
}

function renderInsight(current: DevView): void {
  renderSolo(current);
  const session = current.session;
  if (byId<HTMLDetailsElement>("state-box").open || session.realtime === undefined) {
    byId("state").textContent = JSON.stringify(session.state ?? null, null, 2);
  }
  byId("seed").textContent = session.seed;
  byId("moves").replaceChildren(...session.moves.map((move) => element("li", {}, `${move.seat}${move.bot ? " (Bot)" : ""}: ${JSON.stringify(move.action)}`)));
  for (const entry of session.seats) {
    const frame = frames.get(entry.seat);
    if (frame !== undefined) {
      if (frame.details.open) {
        frame.snapshot.textContent = JSON.stringify(entry.snapshot ?? null, null, 2);
      }
      if (frame.bot !== undefined && frame.botState !== undefined) {
        frame.bot.checked = entry.bot;
        frame.botState.textContent = entry.bot && entry.paused ? " (paused)" : "";
      }
      if (frame.away !== undefined) {
        frame.away.checked = entry.away;
        frame.away.disabled = entry.bot;
      }
      frame.root.classList.toggle("away", entry.away);
      renderProfile(frame, entry);
    }
  }
  const tv = frames.get(screenSeat);
  if (tv !== undefined && tv.details.open) {
    tv.snapshot.textContent = JSON.stringify(session.screen ?? null, null, 2);
  }
}

function render(next: DevView): void {
  const previous = view;
  view = next;
  const key = JSON.stringify([
    next.session.seats.map((entry) => entry.seat),
    next.session.version === undefined,
    next.client.ready,
    next.game?.roles ?? [],
    next.game?.away === "play-on" && next.session.realtime !== undefined,
  ]);
  if (key !== layoutKey) {
    layoutKey = key;
    buildFrames(next);
  } else if (
    previous !== undefined &&
    (previous.client.version !== next.client.version ||
      previous.session.seed !== next.session.seed ||
      previous.language !== next.language ||
      (next.session.version ?? 0) < (previous.session.version ?? 0) ||
      (next.session.realtime?.tick ?? 0) < (previous.session.realtime?.tick ?? 0))
  ) {
    for (const frame of frames.values()) {
      loadFrame(frame);
    }
  }
  renderToolbar(next);
  renderProblems(next);
  renderLogs(next.logs);
  renderInsight(next);
  for (const frame of frames.values()) {
    sendUpdate(frame);
  }
}

addEventListener("message", (event: MessageEvent) => {
  const frame = [...frames.values()].find((candidate) => candidate.iframe !== undefined && candidate.iframe.contentWindow === event.source);
  if (frame === undefined) {
    return;
  }
  const data = event.data as Record<string, unknown> | null;
  if (data !== null && typeof data === "object" && data["gamehearthDev"] === 1 && data["type"] === "log") {
    void post("/__dev/log", { seat: frame.seat, level: data["level"], text: data["text"], stack: data["stack"] });
    return;
  }
  const message = parseGameMessage(event.data);
  if (message === undefined) {
    return;
  }
  if (message.type === "sound") {
    playSound(frame, message.sound);
    return;
  }
  if (message.type === "music") {
    frame.track = message.track;
    refreshMusic();
    return;
  }
  if (message.type === "ready" || message.type === "solo-ready") {
    frame.track = null;
    refreshMusic();
  }
  if (view?.solo !== undefined) {
    handleSolo(frame, message);
    return;
  }
  if (message.type === "ready") {
    frame.ready = true;
    frame.sent = undefined;
    sendSettings(frame);
    sendUpdate(frame);
    return;
  }
  const target = frame.iframe?.contentWindow;
  if (message.type === "solo-ready") {
    target?.postMessage({ gamehearth: bridgeVersion, type: "refused", message: noSoloText }, "*");
    return;
  }
  if (message.type !== "move") {
    target?.postMessage({ gamehearth: bridgeVersion, type: "result", id: message.id, ok: false, code: "not-solo", message: noSoloText }, "*");
    return;
  }
  if (frame.screen) {
    target?.postMessage({ gamehearth: bridgeVersion, type: "result", id: message.id, ok: false, code: "screen", message: "A TV cannot make moves." }, "*");
    return;
  }
  void (post("/__dev/move", { seat: frame.seat, action: message.action, expectedVersion: message.expectedVersion }) as Promise<MoveResult>).then(
    (result) => target?.postMessage({ gamehearth: bridgeVersion, type: "result", id: message.id, ...result }, "*"),
    (error: unknown) =>
      target?.postMessage({ gamehearth: bridgeVersion, type: "result", id: message.id, ok: false, code: "offline", message: error instanceof Error ? error.message : String(error) }, "*"),
  );
});

function soloReply(frame: Frame, message: unknown): void {
  frame.iframe?.contentWindow?.postMessage(message, "*");
}

interface SoloAnswer {
  ok: boolean;
  code?: string;
  message?: string;
  solo?: { saved: unknown; best: Record<string, number> };
}

async function soloAction(body: Record<string, unknown>): Promise<SoloAnswer> {
  try {
    return (await post("/__dev/solo", body)) as SoloAnswer;
  } catch (error) {
    return { ok: false, code: "offline", message: error instanceof Error ? error.message : String(error) };
  }
}

function handleSolo(frame: Frame, message: NonNullable<ReturnType<typeof parseGameMessage>>): void {
  if (message.type === "ready") {
    soloReply(frame, { gamehearth: bridgeVersion, type: "refused", message: soloOnlyText });
    return;
  }
  if (message.type === "solo-ready") {
    frame.ready = true;
    sendSettings(frame);
    void fetch("/__dev/view")
      .then((response) => response.json() as Promise<DevView>)
      .then((current) => soloReply(frame, soloMessage(current.language, current.solo?.saved, current.solo?.best ?? {})));
    return;
  }
  if (message.type === "sound" || message.type === "music") {
    return;
  }
  if (message.type === "move") {
    soloReply(frame, {
      gamehearth: bridgeVersion,
      type: "result",
      id: message.id,
      ok: false,
      code: "solo-game",
      message: "Single-player games without a reducer have no moves; save and best scores go through game.save() and game.record().",
    });
    return;
  }
  if (message.problem !== undefined) {
    soloReply(frame, { gamehearth: bridgeVersion, type: "result", id: message.id, ok: false, code: message.type === "save" ? "invalid-save" : "invalid-stat", message: message.problem });
    return;
  }
  const body = message.type === "save" ? { action: "save", data: message.data } : { action: "record", stat: message.stat, value: message.value };
  void soloAction(body).then((result) => {
    if (result.ok && message.type === "record" && result.solo !== undefined) {
      soloReply(frame, soloMessage(view?.language, result.solo.saved, result.solo.best));
    }
    soloReply(
      frame,
      result.ok
        ? { gamehearth: bridgeVersion, type: "result", id: message.id, ok: true }
        : { gamehearth: bridgeVersion, type: "result", id: message.id, ok: false, code: result.code ?? "platform-error", message: result.message ?? "error in dev" },
    );
  });
}

function reloadSolo(): void {
  for (const frame of frames.values()) {
    loadFrame(frame);
  }
}

function start(): void {
  byId("solo-reload").addEventListener("click", reloadSolo);
  byId("solo-clear-save").addEventListener("click", () => void soloAction({ action: "clear-save" }).then(reloadSolo));
  byId("solo-clear-best").addEventListener("click", () => void soloAction({ action: "clear-best" }).then(reloadSolo));
  if (single !== undefined) {
    document.body.classList.add("single");
  }
  byId("new").addEventListener("click", () => void post("/__dev/new", { playerCount: Number(byId<HTMLSelectElement>("count").value) }));
  byId("language").addEventListener("change", () => void post("/__dev/language", { language: byId<HTMLSelectElement>("language").value }));
  byId("count").addEventListener("change", () => void post("/__dev/new", { playerCount: Number(byId<HTMLSelectElement>("count").value) }));
  byId("pause").addEventListener("click", () => void post("/__dev/pause", { paused: view?.session.realtime?.running === true }));
  byId("step").addEventListener("click", () => void post("/__dev/step", {}));
  byId("state-box").addEventListener("toggle", refreshInsight);
  byId("speed").addEventListener("change", () => void post("/__dev/speed", { speed: Number(byId<HTMLSelectElement>("speed").value) }));
  const sound = byId<HTMLInputElement>("sound");
  sound.checked = soundOn;
  sound.addEventListener("change", () => setSound(sound.checked));
  const music = byId<HTMLInputElement>("music");
  music.checked = musicOn;
  music.addEventListener("change", () => setMusic(music.checked));
  document.addEventListener("visibilitychange", refreshMusic);
  addEventListener("pointerdown", unlockSound, { capture: true });
  addEventListener("keydown", unlockSound, { capture: true });
  const events = new EventSource("/__dev/events");
  events.addEventListener("message", (event) => render(JSON.parse(event.data as string) as DevView));
  events.addEventListener("error", () => {
    byId("status").textContent = "Connection to gamehearth dev lost …";
  });
}

start();
