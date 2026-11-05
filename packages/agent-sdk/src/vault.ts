import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  http,
  parseEventLogs,
  type Account,
  type Address,
  type Chain,
  type Hash,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
  type WalletClient,
} from "viem";

import { AgentRegistryAbi, HLAgentVaultAbi, HLAgentVaultFactoryAbi, HLMarketWhitelistAbi } from "./abis/index.ts";
import { hyperEvmTestnet, LISTING_STATUS, SIGNING_CHAIN_IDS, TESTNET, VAULT_STATUS, type ListingStatus, type VaultStatus } from "./deployments.ts";
import type { CoreOrderStatus, InfoClient } from "./markets.ts";
import { encodeOrder, type EncodedOrder, type OrderRequest } from "./orders.ts";
import { priceIsValid, sizeIsValid } from "./units.ts";

/**
 * Vault mode: an agent trading a trader's `HLAgentVault` clone on HyperEVM.
 *
 * Every order goes through `placeOrder`, which checks the vault's limits *before* the
 * order reaches HyperCore through CoreWriter. The agent's key is the listing's
 * `agentAuthority` in the registry; it can place and cancel orders and nothing else. It
 * cannot withdraw, pause or change limits.
 *
 * ## What a successful transaction does and does not mean
 *
 * A mined `placeOrder` means the vault's checks passed, the reservation was taken and the
 * action was handed to CoreWriter. It does **not** mean HyperCore accepted the order:
 * CoreWriter is fire-and-forget, the action lands a few seconds later, and an order Core
 * rejects (a bad tick, under $10 of notional, no margin in the perp balance) is dropped
 * without the vault ever hearing about it. Ask Core with `coreOrderStatus(cloid)`.
 *
 * The vault cannot see fills either, so a reservation is released only by a cancel or by
 * expiry (one hour) at `reconcile`. **Cancel what you are done with.**
 *
 * ## Simulate, then send
 *
 * Every write is simulated first, so a revert comes back as the contract's own error name
 * (`PositionCapExceeded`, `VenueNotWhitelisted`, `NotAgentAuthority`, ...) in a
 * `VaultRevert`, before any gas is spent.
 *
 * ## Testnet only
 *
 * Writes refuse any chain but HyperEVM testnet (998). See `deployments.ts`.
 */

export type VaultState = {
  address: Address;
  /** The block every field was read at. */
  blockNumber: bigint;
  status: VaultStatus;
  trader: Address;
  listingId: `0x${string}`;
  /** USDC at 1e6, as HyperCore reports it. */
  equity: bigint;
  highWaterMark: bigint;
  pendingBridge: bigint;
  /** Worst-case cost of every order still holding a reservation. */
  reserved: bigint;
  availableToWithdraw: bigint;
  openOrders: number;
  positionCapBps: number;
  maxDrawdownBps: number;
  /** Zero unless fast mode is on. */
  apiWallet: Address;
  trackedAssets: number[];
};

export type Listing = {
  builder: Address;
  agentAuthority: Address;
  status: ListingStatus;
  positionCapBps: number;
  maxDrawdownBps: number;
  executionFeeBps: number;
};

export type Reservation = { asset: number; maxCost: bigint; expiry: bigint; released: boolean };

export type SentTx = { hash: Hash; receipt?: TransactionReceipt };
export type PlacedOrder = SentTx & { cloid: bigint; order: EncodedOrder };

/** The vault refused, in simulation. `reason` is the contract's error name. */
export class VaultRevert extends Error {
  readonly reason: string;

  constructor(reason: string, cause: unknown) {
    super(`vault reverted: ${reason}`, { cause });
    this.reason = reason;
  }
}

export type VaultClientOptions = {
  vault: Address;
  publicClient: PublicClient;
  /** Needed for writes only. Its account is the agent authority (or the trader, for cancels). */
  walletClient?: WalletClient<Transport, Chain, Account>;
};

export class VaultClient {
  readonly address: Address;
  readonly publicClient: PublicClient;
  readonly #wallet: WalletClient<Transport, Chain, Account> | undefined;
  #chainChecked = false;

  constructor(options: VaultClientOptions) {
    this.address = options.vault;
    this.publicClient = options.publicClient;
    this.#wallet = options.walletClient;
  }

  /** A client for HyperEVM testnet over HTTP. Pass `account` to sign. */
  static testnet(options: { vault: Address; account?: Account; rpcUrl?: string }): VaultClient {
    const transport = http(options.rpcUrl ?? hyperEvmTestnet.rpcUrls.default.http[0]);
    return new VaultClient({
      vault: options.vault,
      publicClient: createPublicClient({ chain: hyperEvmTestnet, transport }) as PublicClient,
      ...(options.account === undefined
        ? {}
        : { walletClient: createWalletClient({ chain: hyperEvmTestnet, transport, account: options.account }) }),
    });
  }

  // ─────────────────────────────────────────────────── reads

  /** A no-argument view on the vault, typed loosely: `state()` narrows each result. */
  #read(functionName: string, blockNumber?: bigint): Promise<unknown> {
    return this.publicClient.readContract({
      address: this.address,
      abi: HLAgentVaultAbi,
      functionName: functionName as never,
      ...(blockNumber === undefined ? {} : { blockNumber }),
    });
  }

  /**
   * Everything an agent checks before trading, read at one block.
   *
   * Separate calls pinned to the same block rather than a multicall, because Multicall3
   * is not a given on HyperEVM, and an equity from one block beside a high-water mark
   * from another is a drawdown nobody computed.
   */
  async state(): Promise<VaultState> {
    const blockNumber = await this.publicClient.getBlockNumber();
    const read = (name: string) => this.#read(name, blockNumber);
    const [status, trader, listingId, equity, highWaterMark, pendingBridge, reserved, availableToWithdraw, openOrders, positionCapBps, maxDrawdownBps, apiWallet, trackedAssets] =
      await Promise.all([
        read("status"),
        read("trader"),
        read("listingId"),
        read("equity"),
        read("highWaterMark"),
        read("pendingBridge"),
        read("reserved"),
        read("availableToWithdraw"),
        read("openOrders"),
        read("positionCapBps"),
        read("maxDrawdownBps"),
        read("apiWallet"),
        read("trackedAssets"),
      ]);
    return {
      address: this.address,
      blockNumber,
      status: VAULT_STATUS[Number(status)] ?? "None",
      trader: trader as Address,
      listingId: listingId as `0x${string}`,
      equity: equity as bigint,
      highWaterMark: highWaterMark as bigint,
      pendingBridge: pendingBridge as bigint,
      reserved: reserved as bigint,
      availableToWithdraw: availableToWithdraw as bigint,
      openOrders: Number(openOrders),
      positionCapBps: Number(positionCapBps),
      maxDrawdownBps: Number(maxDrawdownBps),
      apiWallet: apiWallet as Address,
      trackedAssets: (trackedAssets as readonly number[]).map(Number),
    };
  }

  /** The listing this vault trades for, from the registry the vault itself points at. */
  async listing(): Promise<Listing> {
    const [registry, listingId] = await Promise.all([this.#read("registry"), this.#read("listingId")]);
    const l = await this.publicClient.readContract({
      address: registry as Address,
      abi: AgentRegistryAbi,
      functionName: "getListing",
      args: [listingId as `0x${string}`],
    });
    return {
      builder: l.builder,
      agentAuthority: l.agentAuthority,
      status: LISTING_STATUS[l.status] ?? "None",
      positionCapBps: l.positionCapBps,
      maxDrawdownBps: l.maxDrawdownBps,
      executionFeeBps: l.executionFeeBps,
    };
  }

  async reservation(cloid: bigint): Promise<Reservation> {
    const [asset, maxCost, expiry, released] = await this.publicClient.readContract({
      address: this.address,
      abi: HLAgentVaultAbi,
      functionName: "reservations",
      args: [cloid],
    });
    return { asset, maxCost, expiry, released };
  }

  /** Whether `asset` is executable on the whitelist this vault checks. */
  async isListed(asset: number): Promise<boolean> {
    const whitelist = (await this.#read("whitelist")) as Address;
    return this.publicClient.readContract({ address: whitelist, abi: HLMarketWhitelistAbi, functionName: "isListed", args: [asset] });
  }

  /** The order's state on HyperCore, which the vault cannot see. */
  coreOrderStatus(info: InfoClient, cloid: bigint): Promise<CoreOrderStatus> {
    return info.orderStatus(this.address, cloid);
  }

  // ─────────────────────────────────────────────────── writes

  async #signer(): Promise<WalletClient<Transport, Chain, Account>> {
    if (!this.#wallet) throw new Error("this VaultClient has no walletClient; it can only read");
    if (!this.#chainChecked) {
      const chainId = await this.publicClient.getChainId();
      if (!SIGNING_CHAIN_IDS.has(chainId) || this.#wallet.chain.id !== chainId) {
        throw new Error(`refusing to sign on chain ${chainId}: the agent SDK signs on HyperEVM testnet (998) only`);
      }
      this.#chainChecked = true;
    }
    return this.#wallet;
  }

  async #send(
    functionName: "placeOrder" | "cancelOrder" | "cancelAll" | "reconcile",
    args: readonly unknown[],
    wait: boolean
  ): Promise<SentTx> {
    const wallet = await this.#signer();
    let request;
    try {
      ({ request } = await this.publicClient.simulateContract({
        address: this.address,
        abi: HLAgentVaultAbi,
        functionName,
        args: args as never,
        account: wallet.account,
      }));
    } catch (error) {
      throw asVaultRevert(error);
    }
    const hash = await wallet.writeContract(request as never);
    if (!wait) return { hash };
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} transaction ${hash} reverted on chain`);
    return { hash, receipt };
  }

  /**
   * Place one limit order through the vault.
   *
   * Pass `szDecimals` (from `InfoClient.market`) and the price and size are checked
   * against Hyperliquid's tick rules first. Do: HyperCore drops an off-tick order
   * silently, and the vault keeps its reservation until expiry.
   */
  async placeOrder(order: OrderRequest, options: { szDecimals?: number; wait?: boolean } = {}): Promise<PlacedOrder> {
    const encoded = encodeOrder(order);
    if (options.szDecimals !== undefined) {
      if (!priceIsValid(encoded.limitPx, options.szDecimals)) throw new RangeError(`limitPx ${order.limitPx} is off Hyperliquid's tick; use roundPrice`);
      if (!sizeIsValid(encoded.sz, options.szDecimals)) throw new RangeError(`sz ${order.sz} is not a whole number of lots; use roundSize`);
    }
    const sent = await this.#send(
      "placeOrder",
      [encoded.asset, encoded.isBuy, encoded.limitPx, encoded.sz, encoded.reduceOnly, encoded.tif, encoded.cloid],
      options.wait ?? true
    );
    if (sent.receipt) {
      const placed = parseEventLogs({ abi: HLAgentVaultAbi, eventName: "OrderPlaced", logs: sent.receipt.logs });
      if (!placed.some((e) => e.args.cloid === encoded.cloid)) throw new Error(`no OrderPlaced event for cloid ${encoded.cloid} in ${sent.hash}`);
    }
    return { ...sent, cloid: encoded.cloid, order: encoded };
  }

  cancelOrder(cloid: bigint, options: { wait?: boolean } = {}): Promise<SentTx> {
    return this.#send("cancelOrder", [cloid], options.wait ?? true);
  }

  /** Cancel many in one transaction. Unknown or already-released cloids are skipped. */
  cancelAll(cloids: readonly bigint[], options: { wait?: boolean } = {}): Promise<SentTx> {
    return this.#send("cancelAll", [cloids], options.wait ?? true);
  }

  /**
   * Bring the vault's books in line with HyperCore. Permissionless; anyone may call it.
   * `staleCloids` are expired orders whose reservations should be released.
   */
  reconcile(staleCloids: readonly bigint[] = [], options: { wait?: boolean } = {}): Promise<SentTx> {
    return this.#send("reconcile", [staleCloids], options.wait ?? true);
  }
}

/**
 * The vault clone for a trader and a listing, from the factory.
 *
 * Clones are deployed at a deterministic address, so `predictVault` answers whether or
 * not the trader has deployed yet; `deployed` says which. An agent should trade only a
 * vault the factory itself vouches for (`isVault`), never an address it was handed.
 */
export async function findVault(
  publicClient: PublicClient,
  options: { trader: Address; listingId: `0x${string}`; factory?: Address }
): Promise<{ address: Address; deployed: boolean }> {
  const factory = options.factory ?? TESTNET.factory;
  const address = await publicClient.readContract({
    address: factory,
    abi: HLAgentVaultFactoryAbi,
    functionName: "predictVault",
    args: [options.trader, options.listingId],
  });
  const deployed = await publicClient.readContract({ address: factory, abi: HLAgentVaultFactoryAbi, functionName: "isVault", args: [address] });
  return { address, deployed };
}

function asVaultRevert(error: unknown): unknown {
  if (error instanceof BaseError) {
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      return new VaultRevert(revert.data?.errorName ?? revert.reason ?? "unknown", error);
    }
  }
  return error;
}
