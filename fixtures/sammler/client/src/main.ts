import { connectSolo, type MusicTrack } from "@gamehearth/sdk/client";

interface Stand {
  format: 1;
  sterne: number;
  runden: number;
}

const app = document.getElementById("app") as HTMLElement;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, testid: string, text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.dataset["testid"] = testid;
  node.textContent = text;
  app.append(node);
  return node;
}

const melodien: Record<"a" | "b", MusicTrack> = {
  a: { name: "Melodie A", bpm: 120, beats: 2, voices: [{ instrument: "sine", notes: [{ freq: 523.25, at: 0, length: 1 }, { freq: 523.25, at: 1, length: 1 }] }] },
  b: { name: "Melodie B", bpm: 120, beats: 2, voices: [{ instrument: "sawtooth", notes: [{ freq: 392, at: 0, length: 1 }, { freq: 392, at: 1, length: 1 }] }] },
};

function readStand(saved: unknown): Stand {
  if (saved !== null && typeof saved === "object" && (saved as Stand).format === 1) {
    return saved as Stand;
  }
  return { format: 1, sterne: 0, runden: 0 };
}

try {
  const game = await connectSolo<Stand, "sterne" | "dauer" | "unbekannt">();
  let stand = readStand(game.saved);
  const icon = element("img", "icon");
  icon.src = "stern@2x.svg";
  icon.alt = "";
  icon.addEventListener("load", () => (icon.dataset["loaded"] = "ja"));
  icon.addEventListener("error", () => (icon.dataset["loaded"] = "nein"));
  const count = element("p", "count");
  count.className = "big";
  const best = element("p", "best");
  const rounds = element("p", "rounds");
  const star = element("button", "star", "Stern");
  const finish = element("button", "finish", "Runde beenden");
  const wrong = element("button", "wrong", "Falsch melden");
  const status = element("p", "status");
  status.className = "status";
  const musikA = element("button", "music-a", "Melodie A");
  const musikB = element("button", "music-b", "Melodie B");
  const musikAus = element("button", "music-off", "Melodie aus");
  const musik = element("p", "music");
  const zeigeMusik = (on: boolean) => {
    musik.textContent = `Musik: ${on ? "an" : "aus"}`;
  };
  game.onMusic(zeigeMusik);
  zeigeMusik(game.musicOn);
  musikA.addEventListener("click", () => game.music(melodien.a));
  musikB.addEventListener("click", () => game.music(melodien.b));
  musikAus.addEventListener("click", () => game.music(null));
  const show = () => {
    count.textContent = `${stand.sterne} ★`;
    best.textContent = `Rekord: ${game.best.sterne ?? "–"} · Schnellste Runde: ${game.best.dauer ?? "–"}`;
    rounds.textContent = `Runden: ${stand.runden}`;
  };
  star.addEventListener("click", async () => {
    stand = { ...stand, sterne: stand.sterne + 1 };
    show();
    await game.save(stand);
    status.textContent = "gespeichert";
  });
  finish.addEventListener("click", async () => {
    const sterne = stand.sterne;
    await game.record("sterne", sterne);
    await game.record("dauer", 60_000 - sterne * 1000);
    stand = { format: 1, sterne: 0, runden: stand.runden + 1 };
    await game.save(stand);
    show();
    status.textContent = `Runde mit ${sterne} Sternen beendet`;
  });
  wrong.addEventListener("click", async () => {
    try {
      await game.record("unbekannt", 1);
      status.textContent = "angenommen";
    } catch (error) {
      status.textContent = `abgelehnt: ${error instanceof Error ? error.message : String(error)}`;
    }
  });
  show();
  status.textContent = game.saved === undefined ? "neu" : "geladen";
} catch (error) {
  element("p", "error", `Fehler: ${error instanceof Error ? error.message : String(error)}`);
}
