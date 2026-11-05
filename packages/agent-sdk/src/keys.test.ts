import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createCipheriv, pbkdf2Sync, randomBytes, scryptSync } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { keccak256, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { accountFromKeystore, agentAccountFromEnv, decryptKeystore, keystorePath } from "./keys.ts";

/**
 * Keys in these tests are generated on the spot and never funded. No key, keystore or
 * password is checked in; the Foundry check below makes its keystore with `cast` in a
 * temporary directory and deletes it.
 */

function encrypt(key: Hex, password: string, kdf: "scrypt" | "pbkdf2"): string {
  const salt = randomBytes(32);
  const iv = randomBytes(16);
  const derived =
    kdf === "scrypt" ? scryptSync(password, salt, 32, { N: 1 << 10, r: 8, p: 1 }) : pbkdf2Sync(password, salt, 1_000, 32, "sha256");
  const cipher = createCipheriv("aes-128-ctr", derived.subarray(0, 16), iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(key.slice(2), "hex")), cipher.final()]);
  const mac = keccak256(Buffer.concat([derived.subarray(16, 32), ciphertext])).slice(2);
  const kdfparams = kdf === "scrypt" ? { dklen: 32, salt: salt.toString("hex"), n: 1 << 10, r: 8, p: 1 } : { dklen: 32, salt: salt.toString("hex"), c: 1_000, prf: "hmac-sha256" };
  return JSON.stringify({
    version: 3,
    crypto: { cipher: "aes-128-ctr", cipherparams: { iv: iv.toString("hex") }, ciphertext: ciphertext.toString("hex"), kdf, kdfparams, mac },
  });
}

test("v3 keystores decrypt under scrypt and pbkdf2, and a wrong password is refused", () => {
  const key = generatePrivateKey();
  for (const kdf of ["scrypt", "pbkdf2"] as const) {
    const json = encrypt(key, "correct horse", kdf);
    assert.equal(decryptKeystore(json, "correct horse"), key);
    assert.throws(() => decryptKeystore(json, "wrong"), /wrong keystore password/);
  }
});

test("a bare name resolves to Foundry's keystore directory", () => {
  assert.match(keystorePath("agent"), /\.foundry\/keystores\/agent$/);
  assert.equal(keystorePath("/tmp/ks/agent"), "/tmp/ks/agent");
});

test("the agent account comes from a keystore and password file, or a raw key, and nothing else", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-sdk-keys-"));
  try {
    const key = generatePrivateKey();
    await writeFile(join(dir, "agent"), encrypt(key, "pw", "scrypt"));
    await writeFile(join(dir, "pw"), "pw\n");
    const fromKeystore = await agentAccountFromEnv({ AGENT_KEYSTORE: join(dir, "agent"), KEYSTORE_PASSWORD_FILE: join(dir, "pw") });
    assert.equal(fromKeystore.address, privateKeyToAccount(key).address);

    const raw = await agentAccountFromEnv({ AGENT_PRIVATE_KEY: key });
    assert.equal(raw.address, fromKeystore.address);
    await assert.rejects(agentAccountFromEnv({ AGENT_PRIVATE_KEY: "0x1234" }), /64 hex/);
    await assert.rejects(agentAccountFromEnv({}), /AGENT_KEYSTORE/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function hasCast(): boolean {
  try {
    execFileSync("cast", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("a keystore written by Foundry's `cast wallet new` decrypts to the address cast reports", { skip: !hasCast() && "cast is not on PATH" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-sdk-cast-"));
  try {
    execFileSync("cast", ["wallet", "new", dir, "agent", "--unsafe-password", "pw"], { stdio: "ignore" });
    const [file] = await readdir(dir);
    const path = join(dir, file!);
    const expected = execFileSync("cast", ["wallet", "address", "--keystore", path, "--password", "pw"], { encoding: "utf8" }).trim();
    assert.match(await readFile(path, "utf8"), /"kdf":"scrypt"/);
    assert.equal((await accountFromKeystore(path, "pw")).address, expected);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
