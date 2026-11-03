import type { Address, Hex } from "viem";

/**
 * Configuration, read once at start-up and never again.
 *
 * Every variable is resolved up front and a missing one is fatal before any work begins.
 * The alternative — reading `process.env` where it is needed — means a keeper that polls
 * happily for an hour and then throws on the first vault that needs a transaction.
 */

export type Network = "mainnet" | "testnet";

const CHAIN_ID = { mainnet: 999, testnet: 998 } as const;

const INFO_URL = {
  mainnet: "https://api.hyperliquid.xyz/info",
  testnet: "https://api.hyperliquid-testnet.xyz/info",
} as const;

export type CoreConfig = {
  network: Network;
  chainId: 999 | 998;
  rpcUrl: string;
  infoUrl: string;
  registry: Address;
  factory: Address;
  whitelist: Address | null;
  supabaseUrl: string;
  supabaseServiceKey: string;
};

export type IndexerConfig = CoreConfig & {
  startBlock: bigint;
  pollMs: number;
  blockRange: bigint;
};

export type KeeperConfig = CoreConfig & {
  privateKey: Hex;
  pollMs: number;
  maxReconcileIntervalMs: number;
  drawdownWarnMarginBps: bigint;
  /** False means dry run: decide, log, send nothing. */
  send: boolean;
};

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set. See services/.env.example.`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function address(name: string): Address {
  const value = required(name);
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${name} is not an address: ${value}`);
  }
  return value.toLowerCase() as Address;
}

function integer(name: string, fallback: number): number {
  const value = optional(name, String(fallback));
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${value}`);
  }
  return parsed;
}

function core(): CoreConfig {
  const network = optional("NETWORK", "testnet");
  if (network !== "mainnet" && network !== "testnet") {
    throw new Error(`NETWORK must be "mainnet" or "testnet", got ${network}`);
  }

  const whitelist = process.env.WHITELIST_ADDRESS;

  return {
    network,
    chainId: CHAIN_ID[network],
    rpcUrl: required("HYPEREVM_RPC_URL"),
    infoUrl: optional("HYPERLIQUID_INFO_URL", INFO_URL[network]),
    registry: address("REGISTRY_ADDRESS"),
    factory: address("FACTORY_ADDRESS"),
    whitelist: whitelist ? address("WHITELIST_ADDRESS") : null,
    supabaseUrl: required("SUPABASE_URL"),
    supabaseServiceKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  };
}

export function indexerConfig(): IndexerConfig {
  return {
    ...core(),
    startBlock: BigInt(integer("INDEXER_START_BLOCK", 0)),
    pollMs: integer("INDEXER_POLL_MS", 15_000),
    blockRange: BigInt(integer("INDEXER_BLOCK_RANGE", 2_000)),
  };
}

/**
 * The acknowledgement a human has to set, verbatim, before the keeper will sign anything
 * on mainnet.
 *
 * It exists because of the one irreversible thing in this repository: a transaction
 * against contracts that have never been audited and were, at the time of writing, only
 * ever run against a mocked HyperCore. `reconcile` is permissionless and cannot move a
 * trader's money anywhere a trader did not already send it — but it can pause a live
 * vault and fire reduce-only closes, and on mainnet that is somebody's position.
 *
 * A boolean flag would get copied out of an example file without being read. A sentence
 * has to be typed.
 */
export const MAINNET_ACK =
  "I have read services/README.md and accept that this signs mainnet transactions";

export function keeperConfig(): KeeperConfig {
  const base = core();
  const send = optional("KEEPER_SEND", "false") === "true";

  if (send && base.network === "mainnet" && process.env.KEEPER_MAINNET_ACK !== MAINNET_ACK) {
    throw new Error(
      "Refusing to sign on mainnet.\n" +
        "Set KEEPER_MAINNET_ACK to exactly:\n" +
        `  ${MAINNET_ACK}\n` +
        "Or run against testnet (NETWORK=testnet), or with KEEPER_SEND unset for a dry run."
    );
  }

  const privateKey = required("KEEPER_PRIVATE_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("KEEPER_PRIVATE_KEY must be 0x-prefixed 32-byte hex");
  }

  return {
    ...base,
    privateKey: privateKey as Hex,
    pollMs: integer("KEEPER_POLL_MS", 30_000),
    maxReconcileIntervalMs: integer("KEEPER_MAX_RECONCILE_INTERVAL_MS", 3_600_000),
    drawdownWarnMarginBps: BigInt(integer("KEEPER_DRAWDOWN_WARN_MARGIN_BPS", 200)),
    send,
  };
}
