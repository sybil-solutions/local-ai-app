// How `docker run` reads its arguments, closely enough to say what a command line would really start. It is used by
// the stand-in docker of the integration test and by the fuzzer, which asks of every command the app can build: which image
// runs, with which options?
// Options that take a value. Given as `--name value` they take the NEXT argument whatever it is, even one that looks
// like an option, which is exactly how a recipe could once have slipped something in.
const VALUE = new Set(['--name', '--label', '-l', '--gpus', '-p', '--publish', '--security-opt', '--shm-size', '-e', '--env', '-v', '--volume', '--entrypoint', '--ipc', '--ulimit', '--workdir', '-w',
  '--network', '--net', '--restart', '--cap-add', '--cap-drop', '--device', '--pid', '--user', '-u', '--mount', '--runtime', '--add-host', '--hostname', '-h', '--memory', '-m', '--memory-swap', '--cpus', '--userns', '--uts', '--cgroupns', '--env-file', '--volumes-from']);
const BARE = new Set(['-d', '--detach', '--rm', '--privileged', '-i', '--interactive', '-t', '--tty', '--init', '--read-only', '-P', '--publish-all']);

// { options: [[name, value]], image, command } or { error }.
export function parseRun(args) {
  const options = [];
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { i++; break; }
    if (!arg.startsWith('-') || arg === '-') break;
    const eq = arg.indexOf('='), name = eq > 0 ? arg.slice(0, eq) : arg;
    if (BARE.has(name)) { options.push([name, eq > 0 ? arg.slice(eq + 1) : true]); continue; }
    if (!VALUE.has(name)) return { error: `unknown flag: ${name}` };
    if (eq > 0) options.push([name, arg.slice(eq + 1)]);
    else { if (i + 1 >= args.length) return { error: `flag needs an argument: ${name}` }; options.push([name, args[++i]]); }
  }
  if (i >= args.length) return { error: 'requires at least 1 argument' };
  return { options, image: args[i], command: args.slice(i + 1) };
}
