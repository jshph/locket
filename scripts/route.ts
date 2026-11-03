// Dry run: shows what the router would do with a transcript. Calls claude -p only; no notes,
// tasks, events or threads are created.
// Usage: bun run scripts/route.ts "remind me tomorrow at 9am to call the bank" [--at 2026-11-03T06:30:00Z]
import { claudeRouter } from "../src/router.ts";

const args = process.argv.slice(2);
const atIdx = args.indexOf("--at");
const at = atIdx >= 0 ? Date.parse(args.splice(atIdx, 2)[1]) : Date.now();
const transcript = args.join(" ");
if (!transcript || Number.isNaN(at)) {
  console.error('usage: bun run scripts/route.ts "<transcript>" [--at <ISO time>]');
  process.exit(2);
}
console.log(JSON.stringify(await claudeRouter(transcript, at), null, 2));
