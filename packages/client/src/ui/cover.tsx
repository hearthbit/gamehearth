import { useState } from "preact/hooks";

export function hashId(id: string): number {
  let hash = 2166136261;
  for (const char of id) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

const hues = [328, 188, 38, 152, 272, 352, 212, 96];

export function gameHue(id: string): number {
  return hues[(hashId(id) >>> 4) % hues.length] ?? 328;
}

export function gameColor(id: string): string {
  return `hsl(${gameHue(id)}, 95%, 62%)`;
}

export interface CoverPixel {
  x: number;
  y: number;
  bright: boolean;
}

export interface GeneratedCover {
  background: string;
  stripe: string;
  main: string;
  highlight: string;
  pixels: CoverPixel[];
  initial: string;
}

export function generatedCover(id: string, name: string = id): GeneratedCover {
  const hue = gameHue(id);
  let seed = hashId(id);
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  const pixels: CoverPixel[] = [];
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      const roll = random();
      if (roll < 0.5) {
        continue;
      }
      for (const column of x === 2 ? [2] : [x, 4 - x]) {
        pixels.push({ x: 17 + column * 6, y: 9 + y * 6, bright: roll > 0.85 });
      }
    }
  }
  const initial = [...name.trim()][0]?.toUpperCase() ?? "?";
  return {
    background: `hsl(${hue}, 55%, 18%)`,
    stripe: `hsl(${hue}, 60%, 26%)`,
    main: `hsl(${hue}, 90%, 62%)`,
    highlight: `hsl(${(hue + 50) % 360}, 95%, 72%)`,
    pixels,
    initial,
  };
}

const stripes = Array.from({ length: 12 }, (_, index) => index * 4);

export function GeneratedArt({ id, name }: { id: string; name: string }) {
  const art = generatedCover(id, name);
  return (
    <span class="cover-art generated" aria-hidden="true">
      <svg viewBox="0 0 64 48" shape-rendering="crispEdges">
        <rect width="64" height="48" fill={art.background} />
        {stripes.map((y) => (
          <rect key={y} y={y} width="64" height="1" fill={art.stripe} />
        ))}
        {art.pixels.map((pixel) => (
          <rect key={`${pixel.x}-${pixel.y}`} x={pixel.x} y={pixel.y} width="6" height="6" fill={pixel.bright ? art.highlight : art.main} />
        ))}
      </svg>
      <b class="cover-initial">{art.initial}</b>
    </span>
  );
}

export function Cover({ id, name, src }: { id: string; name: string; src?: string | undefined }) {
  const [failed, setFailed] = useState(false);
  const [pixel, setPixel] = useState(false);
  if (src === undefined || src === "" || failed) {
    return <GeneratedArt id={id} name={name} />;
  }
  return (
    <img
      class={pixel ? "cover-art pixel" : "cover-art"}
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      onLoad={(event) => setPixel(event.currentTarget.naturalWidth > 0 && event.currentTarget.naturalWidth < 240)}
      onError={() => setFailed(true)}
    />
  );
}
