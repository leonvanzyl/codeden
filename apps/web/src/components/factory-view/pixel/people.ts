import type { AgentRole } from "./agents";
import { PALETTE, paint } from "./sprites";

/**
 * The people on the floor (#264), drawn by hand for CodeDen: a 10×14 person in a few poses, a
 * uniform colour per role, one accessory per role (a builder's tool belt and vest, a reviewer's
 * glasses and clipboard, a scout's binoculars, an area reviewer's magnifier and badge, a
 * rebaser's wrench, the PM's headset), and a look (skin, hair, hat, shade) seeded from the
 * session id, so an agent stays recognisable while it works.
 */

export type Pose =
  | "stand"
  | "fidget"
  | "walkA"
  | "walkB"
  | "typeA"
  | "typeB"
  | "raise"
  | "cheer"
  | "slump";

export const PERSON_W = 10;
export const PERSON_H = 14;

const SKIN = ["#f4c39b", "#e0a878", "#b77b4c", "#7f4f32"];
const HAIR: [string, string][] = [
  ["#2b1d14", "#1a120c"],
  ["#5a3220", "#3d2115"],
  ["#8a5a2b", "#6b431f"],
  ["#d8a24a", "#b07d2e"],
  ["#b03a2e", "#7d2820"],
  ["#d9d9e0", "#a8a8b5"],
  ["#3a3f5c", "#262b44"],
];
const HATS: [string, string][] = [
  ["#ffcd75", "#d9a13f"],
  ["#e43b44", "#a32a31"],
  ["#41a6f6", "#2a6f9e"],
  ["#38b764", "#257147"],
  ["#f4f4f4", "#b8b9c4"],
];
const UNIFORM: Record<AgentRole, [string, string][]> = {
  builder: [
    ["#3b5dc9", "#29366f"],
    ["#2f6fb0", "#1f4a7a"],
    ["#4a7bd0", "#2d4f8f"],
  ],
  reviewer: [
    ["#38b764", "#257179"],
    ["#2f9e6a", "#1d6b48"],
    ["#5cbf5a", "#2f7a3a"],
  ],
  rebaser: [
    ["#ef7d57", "#b13e53"],
    ["#d9643a", "#8a3a22"],
  ],
  integrator: [
    ["#3fb6b0", "#257179"],
    ["#41a6f6", "#2a6f9e"],
  ],
  scout: [
    ["#b86f50", "#7a3f2c"],
    ["#c28a52", "#6e4527"],
  ],
  area: [
    ["#7f6bd6", "#4f3f99"],
    ["#9b5fc0", "#5f3380"],
  ],
  pm: [
    ["#b13e53", "#6e2238"],
    ["#a3324a", "#5d1c2e"],
  ],
};
const PANTS = ["#333c57", "#4a3a2a", "#2b2f3a"];

/** An agent's look, from its seed and role. */
export interface Look {
  key: string;
  skin: string;
  hair: [string, string];
  style: "short" | "long" | "buzz";
  hat: { colours: [string, string]; shape: "brim" | "beanie" } | null;
  uniform: [string, string];
  pants: string;
}

/** A stable 32-bit hash (FNV-1a) of the seed. */
export function seedHash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const pick = <T>(list: readonly T[], n: number): T => list[n % list.length] as T;

const looks = new Map<string, Look>();

/** The look for a seed (the agent's session id) in a role. Pure: the same seed, the same look. */
export function lookOf(seed: string, role: AgentRole): Look {
  const id = `${role}:${seed}`;
  const known = looks.get(id);
  if (known) return known;
  const look = makeLook(seed, role);
  if (looks.size > 500) looks.clear();
  looks.set(id, look);
  return look;
}

function makeLook(seed: string, role: AgentRole): Look {
  const h = seedHash(seed);
  const part = (shift: number, mod: number) => (h >>> shift) % mod;
  const styles = ["short", "long", "buzz"] as const;
  const hatRoll = part(14, 5);
  return {
    // Everything the look depends on: two seeds with the same hash look the same.
    key: `${role}:${h.toString(36)}`,
    skin: pick(SKIN, part(0, 97)),
    hair: pick(HAIR, part(4, 89)),
    style: pick(styles, part(9, 31)),
    hat:
      hatRoll < 2
        ? { colours: pick(HATS, part(18, 83)), shape: hatRoll === 0 ? "brim" : "beanie" }
        : null,
    uniform: pick(UNIFORM[role], part(23, 7)),
    pants: pick(PANTS, part(27, 5)),
  };
}

const HEADS: Record<Look["style"], string[]> = {
  short: [
    "...kkkk...",
    "..kHHHHk..",
    ".kHHHHHHk.",
    ".khhhhhhk.",
    "..kssssk..",
    "..kksskk..",
    "..kssssk..",
    "...kkkk...",
  ],
  long: [
    "...kkkk...",
    "..kHHHHk..",
    ".kHHHHHHk.",
    ".kHhhhhHk.",
    ".kHssssHk.",
    ".kHksskHk.",
    ".kHssssHk.",
    "..kkkkkk..",
  ],
  buzz: [
    "..........",
    "...kkkk...",
    "..khhhhk..",
    ".khsssshk.",
    "..kssssk..",
    "..kksskk..",
    "..kssssk..",
    "...kkkk...",
  ],
};
const HAT_ROWS = {
  brim: ["...kkkk...", "..kYYYYk..", ".kYYYYYYk.", "kyyyyyyyyk"],
  beanie: ["....kk....", "..kYYYYk..", ".kYYYYYYk.", ".kyyyyyyk."],
};
const BODIES: Record<Exclude<Pose, "slump">, string[]> = {
  stand: ["..kBBBBk..", ".kBBBBBBk.", ".ksBBBBsk.", "..kbbbbk..", "..kLkkLk..", "..kk..kk.."],
  fidget: ["..kBBBBk..", ".kBBBBBBk.", ".ksBBBBsk.", "..kbbbbk..", "..kLkkLk..", "..kk...kk."],
  walkA: ["..kBBBBk..", ".kBBBBBBk.", ".ksBBBBsk.", "..kbbbbk..", "..kLkkLk..", ".kk....kk."],
  walkB: ["..kBBBBk..", ".kBBBBBBk.", ".ksBBBBsk.", "..kbbbbk..", "...kLLk...", "...kkkk..."],
  typeA: ["..kBBBBk..", ".kBBBBBBk.", "skBBBBBBks", "..kbbbbk..", "..kLkkLk..", "..kk..kk.."],
  typeB: ["..kBBBBk..", ".kBBBBBBks", "skBBBBBBk.", "..kbbbbk..", "..kLkkLk..", "..kk..kk.."],
  raise: ["..kBBBBkB.", ".kBBBBBBk.", ".ksBBBBk..", "..kbbbbk..", "..kLkkLk..", "..kk..kk.."],
  cheer: [".BkBBBBkB.", ".kBBBBBBk.", "..kBBBBk..", "..kbbbbk..", "..kLkkLk..", ".kk....kk."],
};
const SLUMP_BODY = [".ksBBBBsk.", ".kBBBBBBk.", ".kLLLLLLk.", ".kkkkkkkk."];

/** How far down the head sits in a pose (a slumped person sits on the floor). */
export const headDrop = (pose: Pose): number => (pose === "slump" ? 2 : 0);

function setAt(rows: string[], x: number, y: number, ch: string) {
  const row = rows[y];
  if (row === undefined || x < 0 || x >= row.length) return;
  rows[y] = row.slice(0, x) + ch + row.slice(x + 1);
}

function rowsOf(look: Look, pose: Pose): string[] {
  const head = [...HEADS[look.style]];
  if (look.hat) head.splice(0, 4, ...HAT_ROWS[look.hat.shape]);
  if (pose === "slump") {
    // Eyes closed.
    head[5] = head[5]?.replace(/k(ss)k/, "s$1s") ?? "";
    return ["..........", "..........", ...head, ...SLUMP_BODY];
  }
  const rows = [...head, ...BODIES[pose]];
  // Arms up: a sleeve and a hand above the shoulder.
  const arm = (x: number) => {
    for (let y = 3; y <= 8; y++) setAt(rows, x, y, "B");
    setAt(rows, x, 2, "s");
  };
  if (pose === "raise" || pose === "cheer") arm(9);
  if (pose === "cheer") arm(0);
  return rows;
}

/** A person in a look and pose, painted once and reused. */
export function person(look: Look, pose: Pose): HTMLCanvasElement {
  return paint(`person:${look.key}:${pose}`, () => ({
    rows: rowsOf(look, pose),
    colours: {
      ...PALETTE,
      s: look.skin,
      H: look.hair[0],
      h: look.hair[1],
      Y: look.hat?.colours[0] ?? look.hair[0],
      y: look.hat?.colours[1] ?? look.hair[1],
      B: look.uniform[0],
      b: look.uniform[1],
      L: look.pants,
    },
  }));
}

/** One accessory per role, drawn over the person: rows and where they go. */
const ACCESSORY: Record<AgentRole, { rows: string[]; x: number; y: number }[]> = {
  builder: [
    // A high-visibility vest stripe, above the desk, and the tool belt below it.
    { rows: ["y..y", "y..y"], x: 3, y: 8 },
    { rows: ["yMyyMy"], x: 2, y: 11 },
  ],
  reviewer: [{ rows: ["kwkkkkwk"], x: 1, y: 5 }],
  scout: [{ rows: ["kMkkMk", "kckkck"], x: 2, y: 4 }],
  area: [{ rows: ["XX", "XX"], x: 3, y: 9 }],
  rebaser: [{ rows: ["m.m", "mmm", ".m.", ".m.", ".m."], x: 8, y: 7 }],
  integrator: [{ rows: ["m.m", "mmm", ".m.", ".m.", ".m."], x: 8, y: 7 }],
  pm: [
    {
      rows: [
        "...MMMM...",
        "..M....M..",
        "..........",
        "..........",
        ".M......M.",
        ".M......M.",
        ".MMM......",
      ],
      x: 0,
      y: 0,
    },
  ],
};

/** The badge colour of each review area. */
export const AREA_COLOUR: Record<string, string> = {
  features: "#41a6f6",
  ux: "#ff77a8",
  performance: "#ffcd75",
  tech_debt: "#a7f070",
  test_gaps: "#73eff7",
  security: "#e43b44",
  bugs: "#ef7d57",
  docs: "#f4f4f4",
};

/** Draws the role's accessory on a person at (x, y) in a pose. */
export function accessory(
  ctx: CanvasRenderingContext2D,
  role: AgentRole,
  pose: Pose,
  x: number,
  y: number,
  area: string | null,
) {
  const dy = headDrop(pose);
  for (const [i, part] of (ACCESSORY[role] ?? []).entries()) {
    // The belt and badge sit on the body, which a slumped person folds.
    if (pose === "slump" && part.y > 7) continue;
    const img = paint(`acc:${role}:${i}:${area ?? "-"}`, () => ({
      rows: part.rows,
      colours: { ...PALETTE, X: AREA_COLOUR[area ?? ""] ?? "#f4f4f4" },
    }));
    ctx.drawImage(img, Math.round(x + part.x), Math.round(y + part.y + dy));
  }
}
