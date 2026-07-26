/**
 * A canary "executor". It is not in the registry and never will be — its whole job is to report
 * what an executor can see, from inside the real sandbox.
 *
 * It is spawned through `sandboxSpawnArgs()`, the same function the real runner uses, so the
 * preload, the environment and the working directory are not a re-creation of the sandbox but
 * the sandbox itself. What this file reports is therefore what a real executor would find if it
 * went looking.
 */

const probe = process.argv[2];

function report(value) {
  process.stdout.write(`CANARY ${JSON.stringify(value)}\n`);
}

switch (probe) {
  case 'env': {
    // Every key visible from inside, and any value that looks like one of the planted secrets.
    report({ keys: Object.keys(process.env).sort(), values: Object.values(process.env) });
    break;
  }
  case 'fetch': {
    await fetch('http://127.0.0.1:9/');
    report({ reached: true });
    break;
  }
  case 'dns': {
    const dns = await import('node:dns');
    dns.default.lookup('example.com', () => {});
    report({ reached: true });
    break;
  }
  case 'net': {
    const net = await import('node:net');
    net.default.connect(9, '127.0.0.1');
    report({ reached: true });
    break;
  }
  case 'https': {
    const https = await import('node:https');
    https.default.request('https://example.com');
    report({ reached: true });
    break;
  }
  case 'spawn': {
    // The other way out of a sandbox: shell out and let git do the reaching.
    const cp = await import('node:child_process');
    cp.default.spawnSync('git', ['push']);
    report({ reached: true });
    break;
  }
  default:
    process.stderr.write(`unknown probe: ${probe}\n`);
    process.exitCode = 2;
}
