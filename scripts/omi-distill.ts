// Runs the real distiller on Omi payload files, without the server or ntfy. It DOES write the
// note (and any new person notes) into the vault: delete them afterwards if this was a test.
// Usage: bun run scripts/omi-distill.ts <payload.json> [more.json ...]
import { claudeDistiller } from "../src/distill.ts";
import { parseOmiPayload, type OmiConversation } from "../src/omi.ts";

const convs = process.argv.slice(2).map((f) => {
  const c = parseOmiPayload(JSON.parse(require("node:fs").readFileSync(f, "utf8")), Date.now());
  if (typeof c === "string") throw new Error(`${f}: ${c}`);
  return c as OmiConversation;
}).sort((a, b) => a.startedAt - b.startedAt);
if (!convs.length) throw new Error("usage: bun run scripts/omi-distill.ts <payload.json> [...]");
const started = Date.now();
console.log(JSON.stringify(await claudeDistiller(convs, `manual-${convs[0].id}`), null, 2));
console.log(`took ${Math.round((Date.now() - started) / 1000)}s`);
