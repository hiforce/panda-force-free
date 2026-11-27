import type { MemoryTerrainLink, MemoryTerrainPlace } from "../../shared/project-memory/contracts.js";
import type { MemoryMapLayout } from "./memory-source-link.js";

type Point = readonly [number, number];
type Terminal = { x: number; y: number; width: number; height: number };
type Route = { link: MemoryTerrainLink; points: Point[] };
const pulseDuration = 900;
const network: readonly Point[] = [
  [0.25, 0.25],
  [0.75, 0.47],
  [0.26, 0.75],
  [0.75, 0.21],
  [0.25, 0.49],
  [0.75, 0.75],
];
const inner: readonly Point[] = [
  [0.25, 0.32],
  [0.75, 0.32],
  [0.75, 0.67],
  [0.25, 0.67],
  [0.5, 0.87],
];
const outer: readonly Point[] = [
  [0.24, 0.14],
  [0.76, 0.85],
  [0.76, 0.14],
  [0.24, 0.85],
];

function positions(places: readonly MemoryTerrainPlace[], mode: MemoryMapLayout, compact: boolean): Point[] {
  if (mode === "timeline")
    return places.map((_, index) => {
      const position = places.length === 1 ? 0.5 : index / (places.length - 1);
      return compact
        ? [index % 2 ? 0.65 : 0.42, 0.16 + position * 0.68]
        : [0.13 + position * 0.74, index % 2 ? 0.68 : 0.36];
    });
  if (mode === "focus") {
    let direct = 0,
      indirect = 0;
    return places.map(({ depth }) => (depth === 1 ? inner[direct++]! : depth === 2 ? outer[indirect++]! : [0.5, 0.49]));
  }
  if (places.length === 1) return [[0.5, 0.48]];
  if (places.length === 2)
    return [
      [0.25, 0.33],
      [0.75, 0.66],
    ];
  return places.map((_, index) => network[index]!);
}

function port(a: Terminal, b: Terminal, offset: number): Point {
  const x = b.x - a.x,
    y = b.y - a.y;
  const scale = Math.max(Math.abs(x) / (a.width / 2 + 3), Math.abs(y) / (a.height / 2 + 3));
  if (!scale) return [a.x, a.y];
  const size = Math.hypot(x, y);
  return [a.x + x / scale - (y * offset) / size, a.y + y / scale + (x * offset) / size];
}

function curve(from: Point, to: Point, tension: number): Point[] {
  const [x, y] = from,
    [endX, endY] = to;
  const rise = Math.min(45, Math.abs(endY - y) / 3);
  const bend = endX - x;
  const a = [x + bend * tension, y - rise];
  const b = [endX - bend * tension, endY - rise];
  return Array.from({ length: 25 }, (_, index) => {
    const t = index / 24;
    const u = 1 - t;
    const mix = (first: number, p: number, q: number, last: number) =>
      u ** 3 * first + 3 * u ** 2 * t * p + 3 * u * t ** 2 * q + t ** 3 * last;
    return [mix(x, a[0]!, b[0]!, endX), mix(y, a[1]!, b[1]!, endY)];
  });
}

function trace(from: Point, to: Point, compact: boolean): Point[] {
  const [a, b] = from,
    [c, d] = to;
  if (compact) {
    const middle = (b + d) / 2;
    return [from, [a, middle], [c, middle], to];
  }
  const middle = (a + c) / 2;
  return [from, [middle, b], [middle, d], to];
}

function pulsePoint(points: readonly Point[], progress: number) {
  const lengths = points.slice(1).map(([x, y], index) => Math.hypot(x - points[index]![0], y - points[index]![1]));
  let traveled = progress * lengths.reduce((sum, length) => sum + length, 0);
  for (const [index, length] of lengths.entries()) {
    if (length && traveled <= length) {
      const [x, y] = points[index]!,
        [endX, endY] = points[index + 1]!;
      return [x + ((endX - x) * traveled) / length, y + ((endY - y) * traveled) / length] as const;
    }
    traveled -= length;
  }
  return points.at(-1)!;
}

export function mountMemoryTerrainNetwork(
  canvas: HTMLCanvasElement,
  markers: ReadonlyMap<string, HTMLButtonElement>,
  places: readonly MemoryTerrainPlace[],
  links: readonly MemoryTerrainLink[],
  mode: MemoryMapLayout,
  hops: 1 | 2,
) {
  const context = canvas.getContext("2d");
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  let selected = "";
  let frame = 0;
  let started = 0;
  let ratio = 1;
  let compact = false;
  let width = 0,
    height = 0;
  let accent = "",
    proof = "",
    backdrop = "";
  let paths: Route[] = [];
  let terminals = new Map<string, Terminal>();

  function paint(progress = 1) {
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.lineCap = "round";
    context.lineJoin = "round";
    const focus = terminals.get(selected);
    const line = (points: readonly Point[]) => {
      context.beginPath();
      context.moveTo(...points[0]!);
      for (const point of points.slice(1)) context.lineTo(...point);
      context.stroke();
    };
    const dot = ([x, y]: Point, size: number) => {
      if (mode === "timeline") context.fillRect(x - size, y - size, size * 2, size * 2);
      else {
        context.beginPath();
        context.arc(x, y, size, 0, 2 * Math.PI);
        context.fill();
      }
    };
    context.strokeStyle = accent;
    context.fillStyle = accent;
    context.lineWidth = 1;

    if (mode === "timeline") {
      const rail = compact ? width * 0.11 : height * 0.15;
      context.globalAlpha = 0.35;
      line(
        compact
          ? [
              [rail, 40],
              [rail, height - 35],
            ]
          : [
              [24, rail],
              [width - 24, rail],
            ],
      );
      for (const { x, y } of terminals.values()) {
        context.globalAlpha = 0.15;
        line(
          compact
            ? [
                [rail, y],
                [width - 15, y],
              ]
            : [
                [x, rail],
                [x, height - 32],
              ],
        );
        context.globalAlpha = 0.65;
        dot(compact ? [rail, y] : [x, rail], 2);
      }
    }
    if (mode !== "timeline" && focus) {
      const rings = mode === "focus" ? (hops === 2 ? [0.27, 0.42] : [0.27]) : [0.145];
      for (const [index, radius] of rings.entries()) {
        context.globalAlpha = index ? 0.32 : 0.38;
        context.setLineDash(index || mode === "network" ? [3, 7] : []);
        context.beginPath();
        context.ellipse(focus.x, focus.y, width * radius, height * radius, 0, 0, 2 * Math.PI);
        context.stroke();
      }
    }
    const focused = ({ from, to }: MemoryTerrainLink) => from === selected || to === selected;
    let highlighted = 0;
    for (const { link, points } of [
      ...paths.filter(({ link }) => !focused(link)),
      ...paths.filter(({ link }) => focused(link)),
    ]) {
      const active = focused(link);
      if (active) highlighted++;
      const color = link.kind === "sameSource" ? proof : accent;
      context.globalAlpha = active ? 1 : selected ? 0.53 : 0.75;
      context.lineWidth = active ? 2.25 : 1.4;
      context.strokeStyle = context.fillStyle = color;
      context.setLineDash(link.kind === "sameSource" ? [4, 5] : []);
      context.shadowBlur = active ? 11 : 0;
      context.shadowColor = color;
      line(points);
      context.setLineDash([]);
      const last = points.at(-1)!;
      dot(points[0]!, active ? 2.35 : 1.6);
      if (link.kind === "dependsOn" || link.kind === "refines") {
        const [previousX, previousY] = points.at(-2)!;
        const angle = Math.atan2(last[1] - previousY, last[0] - previousX);
        const tip = (tilt: number): Point => [
          last[0] - Math.cos(angle + tilt) * 7,
          last[1] - Math.sin(angle + tilt) * 7,
        ];
        line([tip(-0.5), last, tip(0.5)]);
      } else dot(last, active ? 2.35 : 1.6);
      if (active && progress < 1) {
        context.fillStyle = backdrop;
        dot(pulsePoint(link.from === selected ? points : [...points].reverse(), progress), 3.2);
      }
      context.shadowBlur = 0;
    }
    context.globalAlpha = 1;
    canvas.dataset.memoryLinks = String(paths.length);
    canvas.dataset.memoryActiveLinks = String(highlighted);
  }

  function layout() {
    const bounds = canvas.getBoundingClientRect();
    width = bounds.width;
    height = bounds.height;
    compact = width < 500;
    canvas.parentElement?.toggleAttribute("data-memory-compact", compact);
    ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const colors = getComputedStyle(canvas);
    accent = colors.color;
    proof = colors.getPropertyValue("--memory-proof-ink").trim() || accent;
    backdrop = colors.getPropertyValue("--app-panel").trim() || accent;
    for (const [index, [x, y]] of positions(places, mode, compact).entries()) {
      const marker = markers.get(places[index]!.entry.id);
      marker?.style.setProperty("--place-x", x * 100 + "%");
      marker?.style.setProperty("--place-y", y * 100 + "%");
    }
    terminals = new Map(
      [...markers].map(([id, button]) => {
        const { left, top, width, height } = button.getBoundingClientRect();
        return [id, { x: left - bounds.left + width / 2, y: top - bounds.top + height / 2, width, height }];
      }),
    );
    const fromCount = new Map<string, number>();
    paths = links.flatMap((link): Route[] => {
      const a = terminals.get(link.from),
        b = terminals.get(link.to);
      if (!a || !b) return [];
      const counter = fromCount.get(link.from) ?? 0;
      fromCount.set(link.from, counter + 1);
      const from = port(a, b, [0, -4, 4, -7, 7][counter % 5]!);
      const to = port(b, a, 0);
      return [
        {
          link,
          points: mode === "timeline" ? trace(from, to, compact) : curve(from, to, mode === "network" ? 0.48 : 0.23),
        },
      ];
    });
    paint();
  }

  function animate(now: number) {
    frame = 0;
    const progress = motion.matches ? 1 : Math.min(1, (now - started) / pulseDuration);
    paint(progress);
    if (progress < 1) frame = requestAnimationFrame(animate);
  }

  const resize = new ResizeObserver(layout);
  resize.observe(canvas);
  for (const marker of markers.values()) resize.observe(marker);
  const theme = new MutationObserver(layout);
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-appearance"] });
  layout();
  return {
    select(id: string, animateSelection: boolean) {
      if (selected === id) return;
      selected = id;
      cancelAnimationFrame(frame);
      frame = 0;
      paint();
      if (id && animateSelection && !motion.matches && paths.some(({ link }) => link.from === id || link.to === id)) {
        started = performance.now();
        frame = requestAnimationFrame(animate);
      }
    },
    close() {
      cancelAnimationFrame(frame);
      resize.disconnect();
      theme.disconnect();
    },
  };
}
