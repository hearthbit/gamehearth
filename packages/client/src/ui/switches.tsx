import { useDeviceSetting } from "../device-setting";
import { effects } from "../effects";
import { music, toggleMusic } from "../music";
import { sound, toggleSound, unlockAudio } from "../sound";
import { texts } from "../texts";
import { EffectsIcon, MusicIcon, SoundIcon } from "./icons";
import type { MenuItem } from "./menu";

export function SoundSwitch() {
  const [on] = useDeviceSetting(sound);
  return (
    <button
      type="button"
      class="icon-button toggle"
      aria-pressed={on}
      aria-label={texts.sound}
      title={on ? texts.soundOn : texts.soundOff}
      onClick={() => {
        unlockAudio();
        toggleSound(!on);
      }}
    >
      <SoundIcon on={on} />
    </button>
  );
}

export function useSoundItem(): MenuItem {
  const [on] = useDeviceSetting(sound);
  return { label: texts.sound, checked: on, icon: <SoundIcon on={on} />, onSelect: () => toggleSound(!on) };
}

export function MusicSwitch() {
  const [on] = useDeviceSetting(music);
  return (
    <button
      type="button"
      class="icon-button toggle"
      aria-pressed={on}
      aria-label={texts.music}
      title={on ? texts.musicOn : texts.musicOff}
      onClick={() => {
        unlockAudio();
        toggleMusic(!on);
      }}
    >
      <MusicIcon on={on} />
    </button>
  );
}

export function useMusicItem(): MenuItem {
  const [on] = useDeviceSetting(music);
  return { label: texts.music, checked: on, icon: <MusicIcon on={on} />, onSelect: () => toggleMusic(!on) };
}

export function EffectsSwitch() {
  const [on, set] = useDeviceSetting(effects);
  return (
    <button type="button" class="icon-button toggle" aria-pressed={on} aria-label={texts.effects} title={on ? texts.effectsOn : texts.effectsOff} onClick={() => set(!on)}>
      <EffectsIcon on={on} />
    </button>
  );
}

function SettingRow({ id, label, hint, on, onChange }: { id: string; label: string; hint: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <div class="setting">
      <div class="grow">
        <span class="setting-label" id={`${id}-label`}>
          {label}
        </span>
        <span class="setting-hint" id={`${id}-hint`}>
          {hint}
        </span>
      </div>
      <button
        type="button"
        class="switch"
        role="switch"
        aria-checked={on}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-hint`}
        onClick={() => onChange(!on)}
      >
        <span class="switch-knob" aria-hidden="true" />
      </button>
    </div>
  );
}

export function SoundSetting() {
  const [on] = useDeviceSetting(sound);
  return <SettingRow id="setting-sound" label={texts.sound} hint={texts.soundHint} on={on} onChange={toggleSound} />;
}

export function MusicSetting() {
  const [on] = useDeviceSetting(music);
  return <SettingRow id="setting-music" label={texts.music} hint={texts.musicHint} on={on} onChange={toggleMusic} />;
}

export function EffectsSetting() {
  const [on, set] = useDeviceSetting(effects);
  return <SettingRow id="setting-effects" label={texts.effects} hint={texts.effectsHint} on={on} onChange={set} />;
}
