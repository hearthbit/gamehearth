import type { OptionSpec, OptionValue } from "@gamehearth/sdk/platform";
import type { RoomOptions } from "../protocol";
import { tr } from "../language";
import { texts } from "../texts";

export function optionText(option: OptionSpec, value: OptionValue | undefined, languages?: readonly string[]): string {
  if (option.type === "boolean") {
    return value === true ? texts.optionYes : texts.optionNo;
  }
  const choice = option.choices.find((entry) => entry.value === value);
  return choice === undefined ? String(value ?? "") : tr(choice.label, languages);
}

function optionFromText(option: OptionSpec, text: string): OptionValue | undefined {
  if (option.type === "boolean") {
    return text === "true" ? true : text === "false" ? false : undefined;
  }
  return option.choices.find((choice) => String(choice.value) === text)?.value;
}

interface OptionsCardProps {
  options: RoomOptions;
  editable: boolean;
  disabled: boolean;
  hostName: string;
  languages?: readonly string[] | undefined;
  onChange: (name: string, value: OptionValue) => void;
}

export function OptionsCard({ options, editable, disabled, hostName, languages, onChange }: OptionsCardProps) {
  return (
    <section class="card" aria-labelledby="options-title" data-testid="room-options">
      <h2 id="options-title">{texts.options}</h2>
      {Object.entries(options.spec).map(([name, option]) => {
        const value = options.values[name];
        const id = `option-${name}`;
        if (!editable) {
          return (
            <div class="row option" key={name}>
              <span class="grow">{tr(option.label, languages)}</span>
              <strong data-testid={id}>{optionText(option, value, languages)}</strong>
            </div>
          );
        }
        const choices =
          option.type === "boolean"
            ? [
                { value: "true", label: texts.optionYes },
                { value: "false", label: texts.optionNo },
              ]
            : option.choices.map((choice) => ({ value: String(choice.value), label: tr(choice.label, languages) }));
        return (
          <div class="field" key={name}>
            <label for={id}>{tr(option.label, languages)}</label>
            <select
              id={id}
              class="input"
              value={String(value)}
              disabled={disabled}
              onChange={(event) => {
                const next = optionFromText(option, event.currentTarget.value);
                if (next !== undefined && next !== value) {
                  onChange(name, next);
                }
              }}
            >
              {choices.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
          </div>
        );
      })}
      {!editable && <p class="muted small">{texts.optionsByHost(hostName)}</p>}
    </section>
  );
}
