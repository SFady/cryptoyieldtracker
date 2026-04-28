// Usage: node scripts/encrypt-key.mjs 0xTaCléprivée TaPassphrase
import { scryptSync, randomBytes, createCipheriv } from "crypto";

const [,, rawKey, passphrase] = process.argv;

if (!rawKey || !passphrase) {
  console.error("Usage: node scripts/encrypt-key.mjs <private_key> <passphrase>");
  process.exit(1);
}

const salt = randomBytes(16).toString("hex");
const key  = scryptSync(passphrase, salt, 32);
const iv   = randomBytes(16);

const cipher  = createCipheriv("aes-256-cbc", key, iv);
const enc     = Buffer.concat([cipher.update(rawKey, "utf8"), cipher.final()]);

console.log("\nAjoute ces 3 lignes dans .env.local :\n");
console.log(`PRIVATE_KEY_ENC=${enc.toString("hex")}`);
console.log(`PRIVATE_KEY_IV=${iv.toString("hex")}`);
console.log(`PRIVATE_KEY_SALT=${salt}`);
console.log("\nSupprime ensuite PRIVATE_KEY= de .env.local\n");
