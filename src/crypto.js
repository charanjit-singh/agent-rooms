import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { homeDir, writePrivate } from "./config.js";

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const unb64u = (s) => Buffer.from(s, "base64url");

// One X25519 identity per machine user, shared by all of that user's sessions.
export function loadIdentity() {
  const file = path.join(homeDir(), "identity.json");
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  const identity = {
    publicKey: publicKey.export({ format: "jwk" }).x,
    privateKey: privateKey.export({ format: "jwk" }).d,
    createdAt: new Date().toISOString(),
  };
  writePrivate(file, JSON.stringify(identity, null, 2));
  return identity;
}

export function fingerprint(publicKey) {
  return crypto.createHash("sha256").update(unb64u(publicKey)).digest("hex").slice(0, 16).match(/.{4}/g).join(":");
}

function pubKeyObject(x) {
  return crypto.createPublicKey({ key: { kty: "OKP", crv: "X25519", x }, format: "jwk" });
}

function privKeyObject({ publicKey, privateKey }) {
  return crypto.createPrivateKey({ key: { kty: "OKP", crv: "X25519", x: publicKey, d: privateKey }, format: "jwk" });
}

function kek(shared, ephPub, recipientPub) {
  return Buffer.from(crypto.hkdfSync("sha256", shared, Buffer.concat([unb64u(ephPub), unb64u(recipientPub)]), "agent-rooms/v1/wrap", 32));
}

// Encrypt `plaintext` once; wrap the content key for each recipient public key.
export function sealForRecipients(plaintext, recipients) {
  const contentKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", contentKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const keys = {};
  for (const { agentId, publicKey } of recipients) {
    const eph = crypto.generateKeyPairSync("x25519");
    const ephPub = eph.publicKey.export({ format: "jwk" }).x;
    const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: pubKeyObject(publicKey) });
    const wiv = crypto.randomBytes(12);
    const w = crypto.createCipheriv("aes-256-gcm", kek(shared, ephPub, publicKey), wiv);
    const wrapped = Buffer.concat([w.update(contentKey), w.final()]);
    keys[agentId] = [ephPub, b64u(wiv), b64u(wrapped), b64u(w.getAuthTag())].join(".");
  }
  return {
    ciphertext,
    iv: b64u(iv),
    tag: b64u(cipher.getAuthTag()),
    keys,
    sha256: crypto.createHash("sha256").update(plaintext).digest("hex"),
  };
}

export function openSealed({ ciphertext, iv, tag, key, sha256 }, identity) {
  if (!key) throw new Error("this attachment was not encrypted for you");
  const [ephPub, wiv, wrapped, wtag] = key.split(".");
  const shared = crypto.diffieHellman({ privateKey: privKeyObject(identity), publicKey: pubKeyObject(ephPub) });
  const w = crypto.createDecipheriv("aes-256-gcm", kek(shared, ephPub, identity.publicKey), unb64u(wiv));
  w.setAuthTag(unb64u(wtag));
  const contentKey = Buffer.concat([w.update(unb64u(wrapped)), w.final()]);
  const d = crypto.createDecipheriv("aes-256-gcm", contentKey, unb64u(iv));
  d.setAuthTag(unb64u(tag));
  const plaintext = Buffer.concat([d.update(ciphertext), d.final()]);
  if (sha256 && crypto.createHash("sha256").update(plaintext).digest("hex") !== sha256) {
    throw new Error("attachment integrity check failed");
  }
  return plaintext;
}
