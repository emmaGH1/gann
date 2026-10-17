import { Application } from "./application";
import { readConfig } from "./config";
import { ApiError } from "./errors";
import { json } from "./http";
import { createStore } from "./store";

let application: Application | undefined;

// Lazy runtime configuration keeps next build independent of secrets and network.
// A missing production store makes every API fail closed; no fallback is attempted.
export async function handle(request: Request) {
  try {
    if (!application) {
      const config = readConfig();
      application = new Application(config, createStore(config));
    }
    return await application.handle(request);
  } catch (error) {
    return json({ error: error instanceof ApiError ? error.code : "service_unavailable" }, 503);
  }
}
