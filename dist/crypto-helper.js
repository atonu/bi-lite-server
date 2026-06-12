"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.encryptPassword = encryptPassword;
exports.decryptPassword = decryptPassword;
const crypto_1 = __importDefault(require("crypto"));
const ALGORITHM = "aes-256-gcm";
const KEY_HEX_LENGTH = 64; // 32 bytes = 64 hex chars
function getEncryptionKey() {
    const keyHex = process.env.DATABASE_ENCRYPTION_KEY;
    if (!keyHex || keyHex.length !== KEY_HEX_LENGTH) {
        throw new Error("DATABASE_ENCRYPTION_KEY must be a 64-character hex string (32 bytes).");
    }
    return Buffer.from(keyHex, "hex");
}
function encryptPassword(plaintext) {
    const key = getEncryptionKey();
    const iv = crypto_1.default.randomBytes(12); // 96-bit IV for GCM
    const cipher = crypto_1.default.createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    // Format: iv(hex).authTag(hex).ciphertext(hex)
    return `${iv.toString("hex")}.${authTag.toString("hex")}.${encrypted.toString("hex")}`;
}
function decryptPassword(encoded) {
    const key = getEncryptionKey();
    const parts = encoded.split(".");
    if (parts.length !== 3)
        throw new Error("Invalid encrypted password format");
    const [ivHex, authTagHex, ciphertextHex] = parts;
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");
    const ciphertext = Buffer.from(ciphertextHex, "hex");
    const decipher = crypto_1.default.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
    ]).toString("utf8");
}
