// Voiceprints in the local speech service (state/omi/voices.json). Biometric data: local only.
//   bun run scripts/omi-voice.ts list
//   bun run scripts/omi-voice.ts enroll-me [latest|<omi conversation id>] [--replace]
//       Enroll your own voice from a conversation where you talked alone for 30+ seconds
//       (wear the pendant, talk for a minute, wait for Omi to close the conversation).
//   bun run scripts/omi-voice.ts enroll-me --wav /path/to/16khz-mono.wav [--replace]
//   bun run scripts/omi-voice.ts delete <name>
import { resolve } from "node:path";
import { config } from "../src/config.ts";
import { OmiStore } from "../src/omi.ts";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (f: string) => rest.includes(f);
const base = `http://127.0.0.1:${config.asrPort}`;

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

if (cmd === "list") {
  const r = await call("GET", "/voices");
  const names = Object.entries(r.json as Record<string, any>);
  if (!names.length) console.log("No voiceprints yet. Enroll yours: bun run scripts/omi-voice.ts enroll-me latest");
  for (const [name, v] of names) console.log(`${name}: ${v.samples} sample(s), updated ${new Date(v.updated_ms).toLocaleString()}`);
} else if (cmd === "delete" && rest[0]) {
  console.log((await call("DELETE", `/voices/${encodeURIComponent(rest.join(" "))}`)).json);
} else if (cmd === "enroll-me") {
  const replace = flag("--replace");
  const wavAt = rest.indexOf("--wav");
  let body: Record<string, unknown>;
  if (wavAt >= 0) {
    body = { name: "me", wav: resolve(rest[wavAt + 1] ?? ""), replace };
  } else {
    const which = rest.find((a) => !a.startsWith("--")) ?? "latest";
    const convs = new OmiStore(config.stateDir).conversations().filter((c) => c.transcriptSource === "server" || c.enrich);
    const conv = which === "latest" ? convs.sort((a, b) => b.finishedAt - a.finishedAt)[0] : convs.find((c) => c.id === which);
    if (!conv) throw new Error(`no conversation ${which} with audio on this server`);
    console.log(`Using conversation ${conv.id} (${new Date(conv.startedAt).toLocaleString()}, ${Math.round((conv.finishedAt - conv.startedAt) / 1000)} s)`);
    body = { name: "me", start_ms: conv.startedAt - 3000, end_ms: conv.finishedAt + 3000, replace };
  }
  const r = await call("POST", "/voices/enroll", body);
  console.log(r.status, r.json);
  if (r.status === 200 && (r.json.other_seconds ?? 0) > 5) {
    console.log(`Warning: ${r.json.other_seconds} s of other voices were in that audio. If the enrolled voice may not be yours, redo it with --replace.`);
  }
} else {
  console.log("usage: list | enroll-me [latest|<conversation id>|--wav <file>] [--replace] | delete <name>");
}
