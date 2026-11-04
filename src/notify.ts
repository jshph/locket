// Phone confirmations via ntfy. Messages carry only the action and its short title, never the
// full transcript. Disabled (logged only) when NTFY_TOPIC is unset.

import { config } from "./config.ts";
import { fetchWithTimeout, log } from "./util.ts";

export type Notifier = (title: string, message: string, opts?: { urgent?: boolean; quiet?: boolean }) => Promise<void>;

export const ntfyNotifier: Notifier = async (title, message, opts = {}) => {
  if (!config.ntfyTopic) return;
  try {
    const res = await fetchWithTimeout(`${config.ntfyServer}/${encodeURIComponent(config.ntfyTopic)}`, {
      method: "POST",
      headers: {
        Title: title,
        Priority: opts.urgent ? "high" : opts.quiet ? "low" : "default",
        Tags: opts.urgent ? "warning" : opts.quiet ? "zzz" : "white_check_mark",
      },
      body: message,
    }, 10_000);
    if (!res.ok) log("ntfy failed", { status: res.status });
  } catch (e) {
    log("ntfy failed", { error: String(e) });
  }
};
