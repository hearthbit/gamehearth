import type { CatalogEntrySpec } from "@gamehearth/sdk/platform";
import type { BoardEntry, ProfileData, ProfileStatSpec } from "../protocol";
import { tr } from "../language";
import { locale, texts } from "../texts";

export function formatStat(value: number, spec: Pick<ProfileStatSpec, "format"> | undefined): string {
  if (spec?.format === "time") {
    const tenths = Math.round(Math.max(0, value) / 100);
    const hours = Math.floor(tenths / 36_000);
    const minutes = Math.floor((tenths % 36_000) / 600);
    const seconds = Math.floor((tenths % 600) / 10);
    const rest = tenths % 10;
    const clock = `${String(seconds).padStart(2, "0")}${texts.decimalSeparator}${rest}`;
    return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${clock}` : `${minutes}:${clock}`;
  }
  return value.toLocaleString(locale());
}

export function BoardList({ entries, spec }: { entries: BoardEntry[]; spec: Pick<ProfileStatSpec, "format"> }) {
  if (entries.length === 0) {
    return <p class="muted small">{texts.boardEmpty}</p>;
  }
  return (
    <ol class="board">
      {entries.map((entry, index) => (
        <li key={`${entry.rank}-${index}`} class={entry.you ? "you" : undefined}>
          <span class="rank">{entry.rank}.</span>
          <span class="grow">{entry.name}</span>
          <span class="value">{formatStat(entry.value, spec)}</span>
        </li>
      ))}
    </ol>
  );
}

export interface Catalog {
  languages?: readonly string[] | undefined;
  items: Record<string, CatalogEntrySpec>;
  stats: Record<string, ProfileStatSpec>;
  flags: Record<string, CatalogEntrySpec>;
}

export interface ProfileLine {
  section: "items" | "stats" | "flags";
  id: string;
  label: string;
  value: string;
  deprecated: boolean;
}

export function profileLines(profile: ProfileData, catalog: Catalog): ProfileLine[] {
  const lines: ProfileLine[] = [];
  for (const [id, spec] of Object.entries(catalog.items)) {
    const count = Object.hasOwn(profile.items, id) ? profile.items[id] : undefined;
    if (count !== undefined) {
      lines.push({ section: "items", id, label: tr(spec.label, catalog.languages), value: count.toLocaleString(locale()), deprecated: spec.deprecated === true });
    }
  }
  for (const [id, spec] of Object.entries(catalog.stats)) {
    const value = Object.hasOwn(profile.stats, id) ? profile.stats[id] : undefined;
    if (value !== undefined) {
      lines.push({ section: "stats", id, label: tr(spec.label, catalog.languages), value: formatStat(value, spec), deprecated: spec.deprecated === true });
    }
  }
  for (const [id, spec] of Object.entries(catalog.flags)) {
    const value = Object.hasOwn(profile.flags, id) ? profile.flags[id] : undefined;
    if (value !== undefined) {
      lines.push({ section: "flags", id, label: tr(spec.label, catalog.languages), value: value === true ? texts.profileFlagYes : value, deprecated: spec.deprecated === true });
    }
  }
  return lines;
}

export function ProfileView({ profile, catalog }: { profile: ProfileData; catalog: Catalog }) {
  const lines = profileLines(profile, catalog);
  if (lines.length === 0) {
    return <p class="muted small">{texts.profileEmpty}</p>;
  }
  const sections: { key: ProfileLine["section"]; title: string }[] = [
    { key: "items", title: texts.profileItems },
    { key: "stats", title: texts.profileStats },
    { key: "flags", title: texts.profileFlags },
  ];
  return (
    <div class="profile-view">
      {sections.map(({ key, title }) => {
        const shown = lines.filter((line) => line.section === key);
        return shown.length === 0 ? null : (
          <section key={key} data-section={key}>
            <h3>{title}</h3>
            <dl class="profile-list">
              {shown.map((line) => (
                <div key={line.id} data-entry={line.id}>
                  <dt>
                    {line.label}
                    {line.deprecated && <span class="muted small"> ({texts.deprecated})</span>}
                  </dt>
                  <dd>{line.value}</dd>
                </div>
              ))}
            </dl>
          </section>
        );
      })}
    </div>
  );
}
