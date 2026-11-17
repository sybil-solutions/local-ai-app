// Writes a release's signed list of files, which every copy of Local AI checks before it updates (server/release.js):
//   node scripts/sign-release.mjs <folder> <version> <file>...     notes, one per line, on stdin
// It lists each file's size and SHA-256 in <folder>/local-ai-update.json, and signs that list with the release key
// (scripts/release-key.mjs) into local-ai-update.json.sig. The signature is checked here against the key the app
// holds, so a release signed with another key never goes out.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [dir, version, ...names] = process.argv.slice(2);
if (!dir || !/^\d+\.\d+\.\d+$/.test(version || '') || !names.length) { console.error('Usage: node scripts/sign-release.mjs <folder> <version> <file>...'); process.exit(1); }
const keyFile = process.env.LOCAL_AI_SIGNING_KEY || join(homedir(), '.config', 'local-ai', 'release-signing.pem');
const key = createPrivateKey(readFileSync(keyFile));
const files = {};
for (const name of names) {
  const path = join(dir, basename(name));
  files[basename(name)] = { size: statSync(path).size, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
}
const notes = readFileSync(0, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 12);
const list = Buffer.from(`${JSON.stringify({ app: 'local-ai', version, published: new Date().toISOString(), notes, files }, null, 2)}\n`);
const sig = sign(null, list, key);
// The key the app holds, read from the app's own source: the list must check out exactly as a copy will check it.
const pem = /-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----/.exec(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'release.js'), 'utf8'))[0];
if (!verify(null, list, createPublicKey(pem), sig)) { console.error(`${keyFile} is not the release key the app holds (server/release.js). Nothing was signed.`); process.exit(1); }
writeFileSync(join(dir, 'local-ai-update.json'), list);
writeFileSync(join(dir, 'local-ai-update.json.sig'), `${sig.toString('base64')}\n`);
console.log(`Signed the list of ${names.length} files for ${version}`);
