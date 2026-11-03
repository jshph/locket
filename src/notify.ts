// Phone confirmations via ntfy. Messages carry only the action and its short title, never the
// full transcript. Disabled (logged only) when NTFY_TOPIC is unset.

import { config } from "./config.ts";

export type Notifier = (title: string, message: string, opts?: { urgent?: boolean }) => Promise<void>;

export const ntfyNotifier: Notifier = async (title, message, opts = {}) => {
  if (!config.ntfyTopic) return;
  try {
    const res = await fetch(`${config.ntfyServer}/${encodeURIComponent(config.ntfyTopic)}`, {
      method: "POST",
      headers: {
        Title: title,
        Priority: opts.urgent ? "high" : "default",
        Tags: opts.urgent ? "warning" : "white_check_mark",
      },
      body: message,
    });
    if (!res.ok) console.log(JSON.stringify({ t: new Date().toISOString(), msg: "ntfy failed", status: res.status }));
  } catch (e) {
    console.log(JSON.stringify({ t: new Date().toISOString(), msg: "ntfy failed", error: String(e) }));
  }
};
