// PreToolUse hook for the Omi distiller; the rules live in src/omi-guard.ts.
import { runHook } from "../src/omi-guard.ts";

process.exit(await runHook(await Bun.stdin.text(), process.env));
