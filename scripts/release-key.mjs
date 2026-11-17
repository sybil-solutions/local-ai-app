// Makes the key that releases are signed with, once. Every copy of Local AI holds the public half (server/release.js)
// and installs an update only when its list of files is signed with the private half, which stays on the computer
// that publishes releases, readable by its user only, and is never committed or uploaded.
//   node scripts/release-key.mjs        writes ~/.config/local-ai/release-signing.pem and prints the public key
// Run again, it prints the public key of the key that is there and changes nothing. Losing the key means copies
// already out can no longer be updated by themselves: keep a copy of it somewhere safe.
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const KEY_FILE = process.env.LOCAL_AI_SIGNING_KEY || join(homedir(), '.config', 'local-ai', 'release-signing.pem');

if (!existsSync(KEY_FILE)) {
  const { privateKey } = generateKeyPairSync('ed25519');
  mkdirSync(dirname(KEY_FILE), { recursive: true, mode: 0o700 });
  writeFileSync(KEY_FILE, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
  console.error(`Made ${KEY_FILE}. Keep a copy of it somewhere safe.`);
}
const pub = createPublicKey(createPrivateKey(readFileSync(KEY_FILE)));
console.log(pub.export({ type: 'spki', format: 'pem' }).trim());
