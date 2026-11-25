import { useLanguage } from "../language";
import { languages, texts } from "../texts";

const names: Record<(typeof languages)[number], string> = { de: "Deutsch", en: "English" };

export function LanguageSwitch() {
  const { language, choose } = useLanguage();
  return (
    <div class="language-switch" role="group" aria-label={texts.chooseLanguage}>
      {languages.map((code) => (
        <button
          key={code}
          type="button"
          lang={code}
          class={code === language ? "active" : undefined}
          aria-pressed={code === language}
          title={names[code]}
          onClick={() => choose(code)}
        >
          {code.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
