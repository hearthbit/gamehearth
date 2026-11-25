import { useId } from "preact/hooks";
import { texts } from "../texts";
import { themes, useTheme } from "../theme";

export function ThemeSwitch({ compact = false }: { compact?: boolean }) {
  const { theme, choose } = useTheme();
  const name = useId();
  return (
    <div class={compact ? "theme-switch compact" : "theme-switch"} role="radiogroup" aria-label={texts.chooseTheme}>
      {themes.map((option) => (
        <label key={option} class={option === theme ? "theme-option active" : "theme-option"} title={compact ? texts.themeNames[option] : undefined}>
          <input type="radio" class="theme-radio" name={name} value={option} checked={option === theme} onChange={() => choose(option)} />
          <span class={`theme-swatch swatch-${option}`} aria-hidden="true" />
          <span class={compact ? "theme-name visually-hidden" : "theme-name"}>{texts.themeNames[option]}</span>
        </label>
      ))}
    </div>
  );
}
