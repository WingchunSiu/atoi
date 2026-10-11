// Generates the pool of agent avatars in src/assets/avatars.
// Artwork: "Notionists" by Zoish (CC0 1.0), rendered with DiceBear (MIT).
//
// usage: npm run avatars [-- --count 16 --salt atoi]
// Commit the output. The dashboard assigns pool entries to agents at random per run.

import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createAvatar } from "@dicebear/core";
import * as notionists from "@dicebear/notionists";

const { values: args } = parseArgs({
  options: { count: { type: "string", default: "16" }, salt: { type: "string", default: "atoi" } },
});

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "assets", "avatars");
mkdirSync(outDir, { recursive: true });
for (const f of readdirSync(outDir)) if (f.endsWith(".svg")) rmSync(join(outDir, f));

const count = Number(args.count);
for (let i = 1; i <= count; i++) {
  const svg = createAvatar(notionists, {
    seed: `${args.salt}-${i}`,
    // Head-and-shoulders portraits: no hand gestures or shirt icons.
    gestureProbability: 0,
    bodyIconProbability: 0,
    scale: 150,
    translateY: 14,
  }).toString();
  const name = `avatar-${String(i).padStart(2, "0")}.svg`;
  writeFileSync(join(outDir, name), svg);
}
console.log(`wrote ${count} avatars to src/assets/avatars`);
