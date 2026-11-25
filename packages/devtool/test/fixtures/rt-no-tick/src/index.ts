import { dotsGame } from "./dots";

const { tick: _tick, ...rest } = dotsGame();
export default rest;
