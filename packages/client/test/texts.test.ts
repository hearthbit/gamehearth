import { describe, expect, it } from "vitest";
import { errorText } from "../src/texts";

describe("errorText", () => {
  it("shows German texts for codes players can reach instead of the English server message", () => {
    expect(errorText("not-your-turn", "It is not your turn")).toBe("Du bist gerade nicht dran.");
  });

  it("keeps the incident of a game error in the German text", () => {
    expect(errorText("game-error", "An error occurred in the game (incident 3fa2c91b). Details are in the server log.")).toBe(
      "Im Spiel ist ein Fehler aufgetreten (Vorfall 3fa2c91b). Details stehen im Server-Log.",
    );
    expect(errorText("game-error", "The input got no result")).toBe("Im Spiel ist ein Fehler aufgetreten. Details stehen im Server-Log.");
  });

  it("falls back to the server message for codes without a text", () => {
    expect(errorText("install-failed", "Checksum does not match")).toBe("Checksum does not match");
  });
});
