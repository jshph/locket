// Runs the real distiller on Omi payload files, without the server or ntfy. It DOES write the
// note (and any new person notes) into the vault: delete them afterwards if this was a test.
// Usage: bun run scripts/omi-distill.ts <payload.json | --conversation <stored id>> [...]
// A stored conversation (state/omi/conversations) keeps the speech service's transcript and hints.
import { config } from "../src/config.ts";
import { claudeDistiller } from "../src/distill.ts";
import { OmiStore, parseOmiPayload, type OmiConversation } from "../src/omi.ts";

const args = process.argv.slice(2);
const store = new OmiStore(config.stateDir);
const convs: OmiConversation[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--conversation") {
    const c = store.conversation(args[++i]);
    if (!c) throw new Error(`no stored conversation ${args[i]}`);
    convs.push(c);
    continue;
  }
  const c = parseOmiPayload(JSON.parse(require("node:fs").readFileSync(args[i], "utf8")), Date.now());
  if (typeof c === "string") throw new Error(`${args[i]}: ${c}`);
  convs.push(c);
}
convs.sort((a, b) => a.startedAt - b.startedAt);
if (!convs.length) throw new Error("usage: bun run scripts/omi-distill.ts <payload.json> [...]");
const started = Date.now();
console.log(JSON.stringify(await claudeDistiller(convs, `manual-${convs[0].id}`), null, 2));
console.log(`took ${Math.round((Date.now() - started) / 1000)}s`);
