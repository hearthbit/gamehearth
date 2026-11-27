export * from "./index";
export const sdkVersion = "0.1.9";
export { isLanguage, languagePattern, localize, localizedProblem, maxLanguages, pickLanguage, primaryLanguage, supportsLanguage, validateLanguages } from "./i18n";
export type { Localized } from "./i18n";
export { canonicalJson, cloneJson, deepFreeze, findNonJson, jsonEquals, maxStateDepth } from "./json";
export type { JsonProblem } from "./json";
export { applyMove, botMove, checkMove, createMatch, hasBot, legalMoveFor, matchFormat, maxActionDepth, maxActionLength, refreshMatch, stepMatch, tickMs, tickRate } from "./match";
export { fillPlaceholders, hasPlaceholder, maxPlaceholderChars, maxTextPlaceholderLength, placeholderProblem, placeholderTexts, sampleMove, textProblem } from "./placeholder";
export type { PlaceholderRandom } from "./placeholder";
export type {
  BotInput,
  BotOutcome,
  BotProblem,
  CreateMatchOptions,
  GamePhase,
  InputResult,
  Match,
  MatchError,
  MatchErrorCode,
  MatchOutcome,
  Move,
  ProfileInput,
  Step,
  StepInput,
  StepOutcome,
} from "./match";
export {
  defaultOptions,
  maxOptionChoices,
  maxOptionLabelLength,
  maxOptions,
  maxOptionTextLength,
  optionLabel,
  optionNamePattern,
  optionsProblem,
  optionValueProblem,
  resolveOptions,
  validateOptionsSpec,
} from "./options";
export type { BooleanOptionSpec, ChoiceOptionSpec, OptionChoice, OptionSpec, OptionsShape, OptionsSpec } from "./options";
export {
  applyChange,
  catalogIds,
  catalogSections,
  changeProblem,
  cloneProfile,
  emptyProfile,
  hasCatalog,
  isEmptyProfile,
  maxCatalogFlags,
  maxCatalogItems,
  maxCatalogLabelLength,
  maxCatalogStats,
  maxChangesPerCall,
  maxFlagLength,
  maxProfileValue,
  maxSoloStats,
  profileIdPattern,
  profileJson,
  profileOperations,
  profileProblem,
  readProfile,
  validateCatalogSpec,
} from "./profile";
export type {
  CatalogEntrySpec,
  CatalogInput,
  CatalogSection,
  CatalogSpec,
  ChangeProblem,
  ProfileChange,
  ProfileData,
  ProfileOperation,
  StatDirection,
  StatFormat,
  StatSpec,
} from "./profile";
export { allowedPlayerCounts, isPlayerCountAllowed, validatePlayerCountSpec } from "./players";
export type { PlayerCountSpec } from "./players";
export { SeededRandom, maxTotalWeight, randomStateFromSeed } from "./random";
export type { RandomState } from "./random";
export { playerSnapshot, screenSnapshot } from "./snapshot";
export { describeStateProblem, seatIds } from "./state";
export type { AnyGameState } from "./state";
export { bridgeVersion, maxSaveBytes, maxSaveDepth, maxStatValue, parseGameMessage, parsePlatformMessage, recordProblem, saveProblem, statNamePattern } from "./bridge";
export type { BridgeUpdate, GameMessage, MoveResult, PlatformMessage, PlayerInfo, SoloState } from "./bridge";
export {
  isSoundName,
  maxSoundFrequency,
  maxSoundNotes,
  maxSoundSeconds,
  minNoteLength,
  minSoundFrequency,
  readSound,
  soundNames,
  soundNotes,
  soundProblem,
  soundWaves,
} from "./sound";
export type { Note, Sound, SoundName, SoundNotes, SoundWave } from "./sound";
export {
  defaultMusicNoteVolume,
  defaultVoiceVolume,
  maxMusicBeats,
  maxMusicBpm,
  maxMusicNameLength,
  maxMusicNotes,
  maxMusicNotesPerSecond,
  maxMusicPolyphony,
  maxMusicSeconds,
  maxMusicVoices,
  minMusicBpm,
  musicInstruments,
  musicPolyphony,
  musicSeconds,
  readTrack,
  trackLabel,
  trackProblem,
} from "./music";
export type { MusicInstrument, MusicNote, MusicTrack, MusicVoice } from "./music";
export {
  createMusicPlayer,
  musicChangeSeconds,
  musicCrossfadeSeconds,
  musicLimiter,
  musicLookaheadSeconds,
  musicMasterGain,
  musicPeakGain,
  musicTickMs,
} from "./music-player";
export type {
  AudioBufferLike,
  AudioBufferSourceNodeLike,
  AudioContextLike,
  AudioNodeLike,
  AudioParamLike,
  BiquadFilterNodeLike,
  DynamicsCompressorNodeLike,
  GainNodeLike,
  MusicPlayer,
  MusicPlayerOptions,
  MusicTimers,
  OscillatorNodeLike,
} from "./music-player";
export { applyJsonDelta, jsonDelta, type JsonDelta, type JsonDeltaOp, type JsonDeltaResult, type JsonPath } from "./delta";
