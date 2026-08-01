import {chmodSync, existsSync, readFileSync, writeFileSync} from "node:fs";
import {createCipheriv, createDecipheriv, randomBytes} from "node:crypto";

function requireKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("Proxy encryption key must be 32 bytes");
  return key;
}

export function decodeEncryptionKey(value) {
  const key = Buffer.from(value || "", "base64");
  return requireKey(key);
}

export function loadOrCreateEncryptionKey(value, filename) {
  if (value) {
    const key = decodeEncryptionKey(value);
    if (!existsSync(filename)) writeFileSync(filename, `${key.toString("base64")}\n`, {mode: 0o600, flag: "wx"});
    return key;
  }
  if (existsSync(filename)) return decodeEncryptionKey(readFileSync(filename, "utf8").trim());
  const key = randomBytes(32);
  writeFileSync(filename, `${key.toString("base64")}\n`, {mode: 0o600, flag: "wx"});
  chmodSync(filename, 0o600);
  return key;
}

export function encryptSecret(value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", requireKey(key), iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return {iv: iv.toString("base64"), auth_tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64")};
}

export function decryptSecret(record, key) {
  const decipher = createDecipheriv("aes-256-gcm", requireKey(key), Buffer.from(record.iv, "base64"));
  decipher.setAuthTag(Buffer.from(record.auth_tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final()]).toString("utf8");
}
