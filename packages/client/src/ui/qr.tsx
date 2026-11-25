import { encode } from "uqr";

export function qrPath(text: string): { size: number; path: string } {
  const { data, size } = encode(text, { ecc: "M", border: 0 });
  const parts: string[] = [];
  data.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) {
        parts.push(`M${x} ${y}h1v1h-1z`);
      }
    });
  });
  return { size, path: parts.join("") };
}

export function QrCode({ text, label }: { text: string; label: string }) {
  const { size, path } = qrPath(text);
  return (
    <svg class="qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shape-rendering="crispEdges">
      <path d={path} />
    </svg>
  );
}
