// Verifies Pebble Index 01 webhook deliveries (protocol v1). Spec:
// experimental/.../indexwebhook/INDEX_WEBHOOK_API.md in github.com/coredevices/mobileapp.

import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_SKEW_SEC = 300;
export const MAX_BODY_BYTES = 25 * 1024 * 1024;

export function signedBytes(
  version: string, timestamp: string, deliveryId: string, trigger: string, isTest: boolean,
  body: Uint8Array,
): Buffer {
  const prefix = `v${version}\n${timestamp}\n${deliveryId}\n${trigger}\n${isTest ? 1 : 0}\n`;
  return Buffer.concat([Buffer.from(prefix, "utf8"), Buffer.from(body)]);
}

export function sign(secret: string, bytes: Buffer): string {
  return createHmac("sha256", Buffer.from(secret, "utf8")).update(bytes).digest("hex");
}

function signatureMatches(expectedHex: string, givenHex: string): boolean {
  const a = Buffer.from(expectedHex, "utf8");
  const b = Buffer.from(givenHex.toLowerCase(), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export type Delivery =
  | { kind: "test"; trigger: string }
  | { kind: "recording"; id: string; trigger: string; transcription: string; recordedAt: number };

/** Returns the verified delivery, or the HTTP response to send back when it is rejected. */
export async function verifyDelivery(req: Request, secret: string, nowMs = Date.now()): Promise<Delivery | Response> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return new Response("too large", { status: 413 });

  const version = req.headers.get("x-index-webhook-version") ?? "";
  const signature = req.headers.get("x-index-signature") ?? "";
  const timestamp = req.headers.get("x-index-timestamp") ?? "";
  const deliveryId = req.headers.get("x-index-delivery") ?? "";
  const trigger = req.headers.get("x-index-trigger") ?? "";
  const isTest = req.headers.get("x-index-test") === "true";

  if (version !== "1") return new Response("unsupported webhook version", { status: 400 });
  if (!signature || !deliveryId) return new Response("unsigned request", { status: 401 });
  if (!/^\d+$/.test(timestamp) || Math.abs(nowMs / 1000 - Number(timestamp)) > MAX_SKEW_SEC) {
    return new Response("expired or malformed timestamp", { status: 401 });
  }

  const raw = new Uint8Array(await req.arrayBuffer());
  if (raw.byteLength > MAX_BODY_BYTES) return new Response("too large", { status: 413 });
  const expected = sign(secret, signedBytes(version, timestamp, deliveryId, trigger, isTest, raw));
  if (!signatureMatches(expected, signature)) return new Response("invalid signature", { status: 401 });
  if (isTest) return { kind: "test", trigger };

  let form: FormData;
  try {
    // Re-parse the already-read body with only its content type.
    const contentType = req.headers.get("content-type") ?? "";
    form = await new Response(raw, { headers: { "content-type": contentType } }).formData();
  } catch {
    return new Response("unparseable body", { status: 400 });
  }
  const transcription = String(form.get("transcription") ?? "");
  if (!transcription.trim()) {
    // Audio-only payloads carry nothing to route; payload mode must include the transcription.
    return new Response("no transcription", { status: 422 });
  }
  const recordedAt = Number(form.get("recordedAt")) || nowMs;
  return { kind: "recording", id: deliveryId, trigger, transcription, recordedAt };
}
