import type { AnyGameState, Match, MatchError, MatchOutcome } from "../src/platform";

export function expectMatch<S extends AnyGameState, A>(outcome: MatchOutcome<S, A>): Match<S, A> {
  if (!outcome.ok) {
    throw new Error(`expected a valid match, got ${outcome.error.code}: ${outcome.error.message}`);
  }
  return outcome.match;
}

export function expectError<S extends AnyGameState, A>(outcome: MatchOutcome<S, A>): MatchError {
  if (outcome.ok) {
    throw new Error("expected an error, got a valid match");
  }
  return outcome.error;
}
