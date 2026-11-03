// Sends one signed delivery exactly like the ring app does, to exercise the running service end
// to end. This DOES create real notes/tasks/events/threads: clean them up afterwards (AGENTS.md).
// Usage: bun run scripts/send.ts "<transcript>" [--url http://127.0.0.1:8790/index] [--test]
import { sign, signedBytes } from "../src/webhook.ts";

const args = process.argv.slice(2);
const take = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const isTest = args.includes("--test") && (args.splice(args.indexOf("--test"), 1), true);
const url = take("--url") ?? "https://your-host.your-tailnet.ts.net:10000/index";
const transcript = args.join(" ") || "Index webhook test event";

const form = new FormData();
form.set("transcription", transcript);
form.set("recordedAt", String(Date.now()));
form.set("client", "ring");
const encoded = new Response(form);
const body = new Uint8Array(await encoded.arrayBuffer());
const ts = String(Math.floor(Date.now() / 1000));
const id = `manual-${crypto.randomUUID()}`;
const trigger = isTest ? "test-event" : "single-click-hold";
const headers: Record<string, string> = {
  "content-type": encoded.headers.get("content-type")!,
  "x-index-webhook-version": "1",
  "x-index-trigger": trigger,
  "x-index-timestamp": ts,
  "x-index-delivery": id,
  "x-index-signature": sign(process.env.INDEX_WEBHOOK_SECRET ?? "", signedBytes("1", ts, id, trigger, isTest, body)),
};
if (isTest) headers["x-index-test"] = "true";
const res = await fetch(url, { method: "POST", headers, body });
console.log(res.status, await res.text());
