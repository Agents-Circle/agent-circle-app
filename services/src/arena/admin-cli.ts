import { parseArgs } from "node:util";

import { database } from "../shared/db.ts";
import {
  AdminError,
  createSeason,
  disqualify,
  issueEntry,
  moveSeason,
  rotateKey,
  SEASON_STATUSES,
  type SeasonStatus,
  SupabaseStore,
} from "./admin.ts";

/**
 * Season operations, for whoever holds the service-role key.
 *
 *     npm run arena:admin -- season create --slug s0 --name "Season 0" --number 0 \
 *         --starts 2026-11-16T00:00:00Z --ends 2026-12-06T00:00:00Z
 *     npm run arena:admin -- season status --slug s0 --to open
 *     npm run arena:admin -- season show --slug s0
 *     npm run arena:admin -- entry issue --season s0 --wallet 0x… --name "My agent"
 *     npm run arena:admin -- entry rotate --season s0 --entry <uuid>
 *     npm run arena:admin -- entry disqualify --season s0 --entry <uuid> --reason "…"
 *
 * `entry issue` and `entry rotate` print the API key once, on stdout, and nowhere else.
 * Hand it to the builder over a private channel; it cannot be shown again.
 */

const USAGE = "usage: arena:admin season create|status|show … | entry issue|rotate|disqualify …  (see admin-cli.ts)";

function need(values: Record<string, string | undefined>, name: string): string {
  const value = values[name];
  if (value === undefined || value.trim() === "") throw new AdminError(`--${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const [area, verb, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      slug: { type: "string" },
      season: { type: "string" },
      name: { type: "string" },
      number: { type: "string" },
      starts: { type: "string" },
      ends: { type: "string" },
      to: { type: "string" },
      wallet: { type: "string" },
      entry: { type: "string" },
      reason: { type: "string" },
    },
  });

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new AdminError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  const store = new SupabaseStore(database({ supabaseUrl: url, supabaseServiceKey: key }));

  if (area === "season" && verb === "create") {
    const number = Number(need(values, "number"));
    if (!Number.isInteger(number) || number < 0) throw new AdminError("--number must be a whole number");
    const season = await createSeason(store, {
      slug: need(values, "slug"),
      name: need(values, "name"),
      number,
      startsAt: need(values, "starts"),
      endsAt: need(values, "ends"),
    });
    console.log(`created ${season.slug} (id ${season.id}), ${season.status}, rules ${season.rulesHash}`);
  } else if (area === "season" && verb === "status") {
    const to = need(values, "to");
    if (!SEASON_STATUSES.includes(to as SeasonStatus)) throw new AdminError(`--to must be one of ${SEASON_STATUSES.join(", ")}`);
    const season = await moveSeason(store, need(values, "slug"), to as SeasonStatus);
    console.log(`${season.slug} is now ${season.status}`);
  } else if (area === "season" && verb === "show") {
    const season = await store.season(need(values, "slug"));
    if (!season) throw new AdminError("no such season");
    console.log(JSON.stringify(season, null, 2));
    for (const e of await store.entries(season.id)) {
      console.log(`  ${e.id}  ${e.status.padEnd(12)} ${e.builderWallet}  ${e.displayName}  key ${e.keyIssuedAt ?? "none"}`);
    }
  } else if (area === "entry" && verb === "issue") {
    const { entry, apiKey } = await issueEntry(store, need(values, "season"), need(values, "wallet"), need(values, "name"));
    console.error(`entry ${entry.id} (${entry.displayName}) is active. Its API key, shown once:`);
    console.log(apiKey);
  } else if (area === "entry" && verb === "rotate") {
    const apiKey = await rotateKey(store, need(values, "season"), need(values, "entry"));
    console.error("new key below; the old one stops working within a minute:");
    console.log(apiKey);
  } else if (area === "entry" && verb === "disqualify") {
    await disqualify(store, need(values, "season"), need(values, "entry"), need(values, "reason"));
    console.log("disqualified; the Arena drops the entry at its next reload");
  } else {
    throw new AdminError(USAGE);
  }
}

main().catch((error: Error) => {
  console.error(error instanceof AdminError ? error.message : error.stack ?? error.message);
  process.exit(1);
});
