import type { ComponentChildren } from "preact";
import { gamePath, navigate } from "../router";
import { texts } from "../texts";
import { Cover, gameColor } from "./cover";

export function Cabinet({
  id,
  name,
  cover,
  link = true,
  info,
  action,
}: {
  id: string;
  name: string;
  cover?: string | undefined;
  link?: boolean;
  info?: ComponentChildren;
  action?: ComponentChildren;
}) {
  const face = (
    <>
      <span class="marquee">
        <span class="marquee-text" title={name}>{name}</span>
      </span>
      <span class="screen">
        <Cover id={id} name={name} src={cover} />
      </span>
    </>
  );
  return (
    <li class="cabinet" style={{ "--tone": gameColor(id) }}>
      {link ? (
        <a
          class="cabinet-face"
          href={gamePath(id)}
          aria-label={texts.gamePageOpen(name)}
          onClick={(event) => {
            event.preventDefault();
            navigate(gamePath(id));
          }}
        >
          {face}
        </a>
      ) : (
        <div class="cabinet-face">{face}</div>
      )}
      <span class="deck" aria-hidden="true">
        <i class="stick" />
        <i />
        <i class="light" />
      </span>
      {info !== undefined && <div class="cabinet-info">{info}</div>}
      {action !== undefined && <div class="cabinet-action">{action}</div>}
    </li>
  );
}
