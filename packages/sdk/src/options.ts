import { localize, localizedProblem, type Localized } from "./i18n";

export type OptionValue = string | number | boolean;

export type GameOptions = Readonly<Record<string, OptionValue>>;

export type OptionsShape<O> = { readonly [K in keyof O]: OptionValue };

export interface BooleanOptionSpec {
  label: Localized;
  type: "boolean";
  default: boolean;
}

export interface OptionChoice {
  value: string | number;
  label: Localized;
}

export interface ChoiceOptionSpec {
  label: Localized;
  type: "choice";
  default: string | number;
  choices: OptionChoice[];
}

export type OptionSpec = BooleanOptionSpec | ChoiceOptionSpec;

export type OptionsSpec = Record<string, OptionSpec>;

export const optionNamePattern = /^[a-z][a-zA-Z0-9]{0,39}$/;
export const maxOptions = 12;
export const maxOptionChoices = 20;
export const maxOptionLabelLength = 40;
export const maxOptionTextLength = 40;

export function validateOptionsSpec(spec: unknown, languages?: readonly string[] | null): string[] {
  if (!isRecord(spec)) {
    return ['options must be an object like { "stackSevens": { "label": "Stack 7s", "type": "boolean", "default": true } }'];
  }
  const problems: string[] = [];
  const names = Object.keys(spec);
  if (names.length === 0) {
    problems.push("options must not be empty; without options, leave the field out");
  }
  if (names.length > maxOptions) {
    problems.push(`options has ${names.length} entries, at most ${maxOptions} are allowed`);
  }
  for (const name of names) {
    if (name in Object.prototype) {
      problems.push(`options.${name}: this name is already taken in JavaScript, pick another one`);
      continue;
    }
    if (!optionNamePattern.test(name)) {
      problems.push(
        `options.${name}: names start with a lowercase letter, consist of letters and digits (no hyphen, so that ctx.options.${name.replace(/[^a-zA-Z0-9]/g, "")} works) and have at most 40 characters, e.g. "duration" or "stackSevens"`,
      );
      continue;
    }
    problems.push(...optionProblems(name, spec[name], languages));
  }
  return problems;
}

function optionProblems(name: string, option: unknown, languages: readonly string[] | undefined | null): string[] {
  const where = `options.${name}`;
  if (!isRecord(option)) {
    return [`${where} must be an object with label, type and default`];
  }
  const problems: string[] = [];
  const type = option["type"];
  const allowed = type === "choice" ? ["label", "type", "default", "choices"] : ["label", "type", "default"];
  for (const key of Object.keys(option)) {
    if (!allowed.includes(key)) {
      problems.push(`${where}.${key} is unknown, allowed are ${allowed.join(", ")}`);
    }
  }
  const labelProblem = localizedProblem(option["label"], `${where}.label`, maxOptionLabelLength, languages);
  if (labelProblem !== undefined) {
    problems.push(labelProblem);
  }
  if (type === "boolean") {
    if (typeof option["default"] !== "boolean") {
      problems.push(`${where}.default must be true or false for type "boolean"`);
    }
    return problems;
  }
  if (type !== "choice") {
    problems.push(`${where}.type must be "boolean" (yes/no) or "choice" (a choice of fixed values)`);
    return problems;
  }
  const choices = option["choices"];
  if (!Array.isArray(choices) || choices.length < 2 || choices.length > maxOptionChoices) {
    problems.push(`${where}.choices must be a list of 2 to ${maxOptionChoices} entries like { "value": 60, "label": "1 minute" }`);
    return problems;
  }
  const values: (string | number)[] = [];
  choices.forEach((choice, index) => {
    const at = `${where}.choices[${index}]`;
    if (!isRecord(choice)) {
      problems.push(`${at} must be an object like { "value": 60, "label": "1 minute" }`);
      return;
    }
    for (const key of Object.keys(choice)) {
      if (key !== "value" && key !== "label") {
        problems.push(`${at}.${key} is unknown, allowed are value and label`);
      }
    }
    const value = choice["value"];
    if (typeof value === "number" ? !Number.isSafeInteger(value) : !isText(value)) {
      problems.push(`${at}.value must be an integer or a text with 1 to ${maxOptionTextLength} characters`);
    } else if (values.includes(value as string | number)) {
      problems.push(`${at}.value ${JSON.stringify(value)} appears more than once`);
    } else {
      values.push(value as string | number);
    }
    const choiceProblem = localizedProblem(choice["label"], `${at}.label`, maxOptionLabelLength, languages);
    if (choiceProblem !== undefined) {
      problems.push(choiceProblem);
    }
  });
  if (new Set(values.map((value) => typeof value)).size > 1) {
    problems.push(`${where}.choices mixes numbers and texts; all values of a choice have the same type`);
  }
  if (!values.includes(option["default"] as string | number)) {
    problems.push(`${where}.default must be one of the values in choices`);
  }
  return problems;
}

export function defaultOptions(spec: OptionsSpec | undefined): GameOptions {
  return resolveOptions(spec, undefined);
}

export function resolveOptions(spec: OptionsSpec | undefined, chosen: unknown): GameOptions {
  const resolved: Record<string, OptionValue> = {};
  if (spec === undefined) {
    return resolved;
  }
  const wanted = isRecord(chosen) ? chosen : {};
  for (const [name, option] of Object.entries(spec)) {
    const value = Object.hasOwn(wanted, name) ? wanted[name] : undefined;
    resolved[name] = isAllowedValue(option, value) ? value : option.default;
  }
  return resolved;
}

export function optionValueProblem(spec: OptionsSpec | undefined, name: string, value: unknown): string | undefined {
  const option = spec !== undefined && Object.hasOwn(spec, name) ? spec[name] : undefined;
  if (option === undefined) {
    return `The option ${JSON.stringify(name)} does not exist in this game`;
  }
  if (isAllowedValue(option, value)) {
    return undefined;
  }
  const label = localize(option.label);
  return option.type === "boolean"
    ? `${label} is a switch and takes only true or false`
    : `${JSON.stringify(value) ?? String(value)} is not a value for ${label}, possible values are ${option.choices.map((choice) => JSON.stringify(choice.value)).join(", ")}`;
}

export function optionsProblem(options: unknown): string | undefined {
  if (!isRecord(options)) {
    return "options must be an object of names and values";
  }
  const names = Object.keys(options);
  if (names.length > maxOptions) {
    return `options has ${names.length} entries, at most ${maxOptions} are allowed`;
  }
  for (const name of names) {
    if (!optionNamePattern.test(name) || name in Object.prototype) {
      return `${JSON.stringify(name)} is not an option name`;
    }
    const value = options[name];
    const valid =
      typeof value === "boolean" || (typeof value === "number" && Number.isSafeInteger(value)) || (typeof value === "string" && isText(value));
    if (!valid) {
      return `options.${name} must be true, false, an integer or a short text`;
    }
  }
  return undefined;
}

export function optionLabel(option: OptionSpec, value: OptionValue, language?: string): string {
  if (option.type === "boolean") {
    return value === true ? "yes" : "no";
  }
  const choice = option.choices.find((entry) => entry.value === value);
  return choice === undefined ? String(value) : localize(choice.label, language);
}

function isAllowedValue(option: OptionSpec, value: unknown): value is OptionValue {
  if (option.type === "boolean") {
    return typeof value === "boolean";
  }
  return (typeof value === "string" || typeof value === "number") && option.choices.some((choice) => choice.value === value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= maxOptionTextLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
