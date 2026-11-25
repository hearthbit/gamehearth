import { readFileSync } from "node:fs";
import { countingGame } from "./counting";

export const peek = () => readFileSync("geheim.txt", "utf8");
export default countingGame();
