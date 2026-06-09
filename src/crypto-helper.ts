import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_HEX_LENGTH = 64; // 32 bytes = 64 hex chars

function getEncryptionKey(): Buffer {
  const keyHex = process.env.DATABASE_ENCRYPTION_KEY;
  if (!keyHex || keyHex.length !== KEY_HEX_LENGTH) {
    throw new Error(
      "DATABASE_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)."
    );
  }
  return Buffer.from(keyHex, "hex");
}

export function encryptPassword(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Format: iv(hex).authTag(hex).ciphertext(hex)
  return `${iv.toString("hex")}.${authTag.toString("hex")}.${encrypted.toString("hex")}`;
}

export function decryptPassword(encoded: string): string {
  const key = getEncryptionKey();
  const parts = encoded.split(".");
  if (parts.length !== 3) throw new Error("Invalid encrypted password format");

  const [ivHex, authTagHex, ciphertextHex] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}
