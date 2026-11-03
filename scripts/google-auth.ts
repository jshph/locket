// One-time Google Calendar sign-in. Prints a link; opening it and approving sends Google back to
// this server's /oauth/google/callback (the service must be running), which stores the token.
// Usage: bun run scripts/google-auth.ts   (from the project directory)
import { beginGoogleAuth } from "../src/google.ts";

console.log(beginGoogleAuth());
console.log("\nOpen the link above within 15 minutes and approve access.");
