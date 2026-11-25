import { countingGame } from "./counting";

let warm = 0;
while (warm >= 0) {
  warm = (warm + 1) % 10;
}

export default countingGame();
