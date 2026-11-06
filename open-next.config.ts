import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import r2IncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache";

// Pages with `revalidate` (the Arena leaderboard refreshes every 60 s) need an incremental
// cache; the R2 bucket named in wrangler.jsonc is it.
export default defineCloudflareConfig({ incrementalCache: r2IncrementalCache });
