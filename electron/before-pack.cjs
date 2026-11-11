// Run by electron-builder before it packs the app. Copies the files the app sends to another machine when it
// installs itself there into build/payload, which is shipped beside the archive as a plain folder. (Shipping the
// originals that way would take them out of the archive the app itself runs from.)
const { cpSync, mkdirSync, rmSync } = require('node:fs');
const { join } = require('node:path');

exports.default = async function beforePack(context) {
  const root = context.packager.projectDir, out = join(root, 'build', 'payload');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const name of ['server', 'web', 'install.sh', 'README.md', 'package.json']) cpSync(join(root, name), join(out, name), { recursive: true });
};
