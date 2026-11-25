import { render } from "preact";
import { App } from "./app";
import { applyEffects, startIntro, watchIdle } from "./effects";
import { handleWorkerMessage } from "./push";
import { installSounds } from "./sound";
import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/screens.css";
import "./styles/neon.css";
import "./styles/crt.css";
import "./styles/front.css";

applyEffects();
startIntro();
watchIdle();
installSounds();

const root = document.getElementById("app");
if (root !== null) {
  render(<App />, root);
}

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event) => handleWorkerMessage(event.data));
  addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}
