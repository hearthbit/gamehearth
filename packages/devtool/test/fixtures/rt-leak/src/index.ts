import { dotsGame } from "./dots";

export default dotsGame({
  legalMoves(state) {
    return state.secret.colors[0] === "rot" ? [{ type: "dir", dir: 1 }] : [{ type: "dir", dir: -1 }];
  },
});
