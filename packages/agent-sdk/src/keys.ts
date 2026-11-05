import { createDecipheriv, pbkdf2Sync, scryptSync, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { keccak256, toHex, type Hex, type LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Where an agent's key comes from: the environment, or a Foundry keystore. Never a file
 * in a repository, and never a pasted literal.
 *
 * A Foundry keystore is what `cast wallet import <name> --interactive` writes to
 * `~/.foundry/keystores/<name>`: a Web3 Secret Storage v3 file, the key encrypted under a
 * password. `accountFromKeystore` decrypts it in memory, the way `cast --account <name>`
 * does, so the same keystore signs from `cast` and from an agent.
 *
 * Testnet keys only until there is an audited mainnet deployment.
 */

/** `~/.foundry/keystores/<name>`, or `name` itself if it is a path. */
export function keystorePath(nameOrPath: string): string {
  return nameOrPath.includes("/") ? nameOrPath : join(homedir(), ".foundry", "keystores", nameOrPath);
}

type V3Keystore = {
  version: number;
  crypto: {
    cipher: string;
    cipherparams: { iv: string };
    ciphertext: string;
    kdf: "scrypt" | "pbkdf2";
    kdfparams: { dklen: number; salt: string; n?: number; r?: number; p?: number; c?: number; prf?: string };
    mac: string;
  };
};

/** Decrypt a v3 keystore to its private key. Throws on a wrong password. */
export function decryptKeystore(json: string, password: string): Hex {
  const keystore = JSON.parse(json) as V3Keystore;
  // `crypto` is lower-case in the spec and capitalised by some older writers.
  const c = keystore.crypto ?? (keystore as unknown as { Crypto: V3Keystore["crypto"] }).Crypto;
  if (keystore.version !== 3) throw new Error(`unsupported keystore version ${keystore.version}`);
  if (c.cipher !== "aes-128-ctr") throw new Error(`unsupported keystore cipher ${c.cipher}`);

  const salt = Buffer.from(c.kdfparams.salt, "hex");
  const dklen = c.kdfparams.dklen;
  let derived: Buffer;
  if (c.kdf === "scrypt") {
    const { n, r, p } = c.kdfparams as { n: number; r: number; p: number };
    derived = scryptSync(password, salt, dklen, { N: n, r, p, maxmem: 256 * n * r + 1024 * 1024 });
  } else if (c.kdf === "pbkdf2") {
    if (c.kdfparams.prf !== "hmac-sha256") throw new Error(`unsupported pbkdf2 prf ${c.kdfparams.prf}`);
    derived = pbkdf2Sync(password, salt, c.kdfparams.c!, dklen, "sha256");
  } else {
    throw new Error(`unsupported keystore kdf ${String(c.kdf)}`);
  }

  const ciphertext = Buffer.from(c.ciphertext, "hex");
  const mac = Buffer.from(keccak256(Buffer.concat([derived.subarray(16, 32), ciphertext])).slice(2), "hex");
  if (!timingSafeEqual(mac, Buffer.from(c.mac, "hex"))) throw new Error("wrong keystore password");

  const decipher = createDecipheriv("aes-128-ctr", derived.subarray(0, 16), Buffer.from(c.cipherparams.iv, "hex"));
  const key = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return toHex(key);
}

export async function accountFromKeystore(nameOrPath: string, password: string): Promise<LocalAccount> {
  const json = await readFile(keystorePath(nameOrPath), "utf8");
  return privateKeyToAccount(decryptKeystore(json, password));
}

/**
 * Read a password from the terminal without echoing it.
 *
 * Prompted rather than read from an environment variable by default, because a password
 * in the environment of a long-running process is readable by anything that can read
 * `/proc/<pid>/environ`.
 */
export async function promptPassword(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) throw new Error("no terminal to prompt for the keystore password on; set KEYSTORE_PASSWORD_FILE");
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  try {
    return await new Promise<string>((resolve, reject) => {
      let value = "";
      const onData = (chunk: string) => {
        for (const ch of chunk) {
          if (ch === "\r" || ch === "\n") {
            stdin.off("data", onData);
            process.stderr.write("\n");
            return resolve(value);
          }
          if (ch === "\u0003") {
            stdin.off("data", onData);
            return reject(new Error("cancelled"));
          }
          value = ch === "\u007f" ? value.slice(0, -1) : value + ch;
        }
      };
      stdin.on("data", onData);
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
}

/**
 * The agent's signing account, from the environment:
 *
 * - `AGENT_KEYSTORE=<name or path>`: a Foundry keystore. The password is read from
 *   `KEYSTORE_PASSWORD_FILE` if set, otherwise prompted for.
 * - `AGENT_PRIVATE_KEY=0x…`: a raw key. For throwaway testnet keys in CI-like setups only.
 *
 * The keystore wins if both are set.
 */
export async function agentAccountFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<LocalAccount> {
  const keystore = env.AGENT_KEYSTORE;
  if (keystore) {
    const passwordFile = env.KEYSTORE_PASSWORD_FILE;
    const password = passwordFile
      ? (await readFile(passwordFile, "utf8")).replace(/\r?\n$/, "")
      : await promptPassword(`Password for keystore ${keystore}: `);
    return accountFromKeystore(keystore, password);
  }
  const key = env.AGENT_PRIVATE_KEY;
  if (key) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("AGENT_PRIVATE_KEY must be 0x and 64 hex digits");
    return privateKeyToAccount(key as Hex);
  }
  throw new Error("set AGENT_KEYSTORE (a Foundry keystore name or path) or AGENT_PRIVATE_KEY");
}
