// The one docker command that starts an engine, built from a recipe. Nothing here runs anything: it turns a recipe
// and a run into a list of arguments. So what a recipe can and cannot make Docker do is decided in this file, and is
// checked without Docker by scripts/fuzz.mjs.
// Options the app sets itself. A recipe's own value for any of these is dropped.
const OWNED = new Set(['--network', '--net', '--gpus', '--name', '--rm', '-d', '--detach', '-p', '--publish', '--label', '--entrypoint', '--restart']);
// Options a registry recipe may add. Each takes exactly one value.
const ALLOWED = new Set(['--ipc', '--network', '--net', '--gpus', '--shm-size', '--ulimit', '--workdir', '-w']);
// Engines that only count tokens when asked to.
const METRICS = [[/sglang/, '--enable-metrics'], [/llama-server/, '--metrics']];

// A recipe's extra options as [name, value] pairs: `--ipc host`, `--ipc=host` and `-w /x` are one pair each, and a
// name on its own has no value (null).
export const flagsOf = (launch) => [].concat(launch.flags || []).map((flag) => {
  const m = /^\s*(--?[\w-]+)(?:[=\s]+([\s\S]*?))?\s*$/.exec(String(flag));
  return m ? [m[1], m[2] ?? null] : [String(flag), null];
});
// What is wrong with a registry recipe's options, or null. Each must be an allowed option with one value that is a
// single word and does not begin with a dash. A value is required because Docker gives an option with none the next
// argument, which would be one of the app's own or the image.
export function flagProblem(launch) {
  // --ipc may share memory with the host or keep its own. Joining another container's (container:<name>) is not for a recipe to choose.
  const bad = flagsOf(launch).find(([name, value]) => !ALLOWED.has(name) || value === null || !/^[^\s-]\S*$/.test(value) || (name === '--ipc' && !/^(host|private|shareable|none)$/.test(value)));
  return bad ? (bad[0].trim() ? `Uses ${`${bad[0]} ${bad[1] ?? ''}`.trim().slice(0, 60)}` : 'Has an empty Docker option') : null;
}

// The arguments for `docker`. run: { id, recipe, gpus, since, reachable }. `bind` is the addresses the engine's port
// is published on. `mounts` are the weights' -v arguments, `configFile` the recipe's config written to disk, and
// `trusted` says the recipe is the user's own (which may do what it likes; a registry recipe may not gain privileges).
// Every option is written as one word (name=value), so none can take another's place.
export function dockerArgs({ run, launch, name, bind, mounts = [], configFile = null, trusted = false }) {
  const entry = [].concat(launch.entrypoint || []).map(String), command = [...entry, ...[].concat(launch.args || []).map(String)];
  const metrics = METRICS.find(([re, flag]) => re.test(command.join(' ')) && !command.includes(flag))?.[1];
  const kept = flagsOf(launch).filter(([flag]) => !OWNED.has(flag)).map(([flag, value]) => (value === null ? flag : `${flag}=${value}`));
  const env = Object.entries(launch.env || {}).filter(([k]) => !['NVIDIA_VISIBLE_DEVICES', 'CUDA_VISIBLE_DEVICES'].includes(k));
  return ['run', '-d', `--name=${name}`,
    '--label=local-ai=1', `--label=local-ai.port=${run.id}`, `--label=local-ai.recipe=${run.recipe}`, `--label=local-ai.gpus=${run.gpus.join('+')}`, `--label=local-ai.since=${run.since}`, `--label=local-ai.reach=${+run.reachable}`,
    `--gpus="device=${run.gpus.join(',')}"`, ...bind.map((host) => `--publish=${host}:${run.id}:${launch.port}`),
    ...(trusted ? [] : ['--security-opt=no-new-privileges']), ...(launch.shm ? [`--shm-size=${launch.shm}`] : []), ...kept,
    ...env.map(([k, v]) => `--env=${k}=${v}`), ...mounts, ...(configFile ? [`--volume=${configFile}:${launch.config.at}:ro`] : []),
    ...(entry[0] ? [`--entrypoint=${entry[0]}`] : []), '--', launch.image, ...entry.slice(1), ...[].concat(launch.args || []).map(String), ...(metrics ? [metrics] : [])];
}
