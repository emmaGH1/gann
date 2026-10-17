import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// This course uses dynamic routes and externally-backed session/payment state;
// don't add KV/R2/Queues until a concrete cache/revalidation need is reviewed.
export default defineCloudflareConfig();
