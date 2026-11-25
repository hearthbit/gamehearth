export interface Cell {
  x: number;
  y: number;
}

export interface Level {
  width: number;
  height: number;
  walls: Cell[];
  start: Cell;
  mushrooms: Cell[];
}

export const symbols = { wall: "#", floor: ".", start: "S", mushroom: "M" } as const;

export const levelTexts: readonly string[] = [
  `
############
#S.........#
#.##.##.##.#
#.#M......M#
#.#.####.#.#
#......#.#.#
####.#.#...#
#M...#.###.#
#.####.....#
#......###.#
#.##.#...#.#
#.#..#.#M#.#
#.#.##.#.#.#
#...#..#...#
#.#...##.#.#
#M#.#......#
############`,
  `
############
#M...#....M#
#.##.#.##..#
#.#..#..#.##
#.#.###.#..#
#.#...#.##.#
#.###.#....#
#...#.####.#
###.#....#.#
#M..####.#.#
#.#......#.#
#.#.####.#.#
#.#.#M.#...#
#.#.#..###.#
#...#.....M#
#S###.###..#
############`,
  `
############
#S#M.....#M#
#.#.###.##.#
#.#.#M#....#
#...#.#.####
###.#.#....#
#M#.#.####.#
#.#...#M...#
#.#####.####
#.......#.M#
#.#.###.#.##
#.#.#M#.#..#
#.#.#.#.##.#
#.#...#....#
#.#####.##.#
#M......#M.#
############`,
];

export function parseLevel(text: string): Level {
  const rows = text.trim().split(/\r?\n/).map((row) => row.trim());
  const width = rows[0]?.length ?? 0;
  const walls: Cell[] = [];
  const mushrooms: Cell[] = [];
  let start: Cell | undefined;
  rows.forEach((row, y) => {
    if (row.length !== width) {
      throw new Error(`Row ${y + 1} is ${row.length} characters long, the first one ${width}; all rows must have the same length`);
    }
    [...row].forEach((symbol, x) => {
      if (symbol === symbols.wall) {
        walls.push({ x, y });
      } else if (symbol === symbols.mushroom) {
        mushrooms.push({ x, y });
      } else if (symbol === symbols.start) {
        if (start !== undefined) {
          throw new Error("A level has exactly one start S");
        }
        start = { x, y };
      } else if (symbol !== symbols.floor) {
        throw new Error(`Unknown character "${symbol}" in row ${y + 1}; allowed are # . S M`);
      }
    });
  });
  if (start === undefined) {
    throw new Error("A level needs a start S");
  }
  if (mushrooms.length === 0) {
    throw new Error("A level needs at least one mushroom M");
  }
  return { width, height: rows.length, walls, start, mushrooms };
}

export const levels: readonly Level[] = levelTexts.map(parseLevel);

export function reachable(level: Level): Set<string> {
  const blocked = new Set(level.walls.map((cell) => `${cell.x},${cell.y}`));
  const seen = new Set<string>([`${level.start.x},${level.start.y}`]);
  const queue: Cell[] = [level.start];
  while (queue.length > 0) {
    const cell = queue.shift() as Cell;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const next = { x: cell.x + dx, y: cell.y + dy };
      const key = `${next.x},${next.y}`;
      if (next.x < 0 || next.y < 0 || next.x >= level.width || next.y >= level.height || blocked.has(key) || seen.has(key)) {
        continue;
      }
      seen.add(key);
      queue.push(next);
    }
  }
  return seen;
}
