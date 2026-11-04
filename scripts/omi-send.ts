// POSTs an Omi conversation payload to the running service like Omi's backend does. The
// conversation is merged and distilled for real (a vault note + ntfy): clean up afterwards.
// Usage: bun run scripts/omi-send.ts <payload.json> [--url http://127.0.0.1:8790]
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const i = args.indexOf("--url");
const base = i >= 0 ? args.splice(i, 2)[1] : "http://127.0.0.1:8790";
const body = readFileSync(args[0] ?? "", "utf8");
const res = await fetch(`${base}/omi/${process.env.OMI_WEBHOOK_SECRET ?? ""}?uid=manual`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body,
});
console.log(res.status, await res.text());
