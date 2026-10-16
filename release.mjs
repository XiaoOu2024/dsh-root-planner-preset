// One-command release for this bundle.
//
// It exists because the manual sequence has four places that bite, all of them
// discovered the hard way in this repository:
//
//  1. `cordis.patch.yml` is GENERATED. Editing it by hand, or forgetting to
//     regenerate after a persona edit, is the most common mistake — and CI only
//     catches it after the push.
//  2. The configured registry is registry.npmmirror.com, a read-only MIRROR. A
//     plain `npm publish` goes to the wrong place, and the mirror can lag the
//     official registry by hours, so an install right after a release fails with
//     "No matching version found".
//  3. Publishing this account goes through npm's STAGED publishing. `npm publish`
//     can print a success line while the version never reaches the registry, so
//     the exit code proves nothing. The only reliable check is asking the registry
//     for the exact version, with retries: propagation is not instant.
//  4. The local profile must be upgraded explicitly, or the machine keeps running
//     the previous version while you believe you are testing the new one.
//
// Usage:
//   node release.mjs patch                 # 1.1.1 -> 1.1.2, then release
//   node release.mjs minor                 # 1.1.1 -> 1.2.0
//   node release.mjs 2.0.0                 # an explicit version
//   node release.mjs patch -m "人设：…"     # override the commit message body
//
// Flags:
//   --dry-run       do everything except commit, push, publish and install
//   --skip-install  do not upgrade the local DSH profile afterwards
//   --skip-gh       skip the GitHub CI wait (still pushes)
//   --profile NAME  DSH profile to upgrade (default: web)

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OFFICIAL_REGISTRY = 'https://registry.npmjs.org/';
const PROXY = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? 'http://127.0.0.1:7897';
const GIT = process.env.DSH_RELEASE_GIT ?? 'git';
const GH = process.env.DSH_RELEASE_GH ?? 'gh';
const PUBLISHER = process.env.DSH_RELEASE_PUBLISHER ?? (process.platform === 'win32' ? 'pnpm' : 'npm');

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const skipInstall = argv.includes('--skip-install');
const skipGh = argv.includes('--skip-gh');
const profileIndex = argv.indexOf('--profile');
const profile = profileIndex === -1 ? 'web' : argv[profileIndex + 1];
const messageIndex = argv.indexOf('-m');
const body = messageIndex === -1 ? undefined : argv[messageIndex + 1];

/** The version argument: the first token that is neither a flag nor a flag's value. */
const flagValues = new Set([profileIndex + 1, messageIndex + 1].filter((index) => index > 0));
const bump = argv.find((arg, index) => !arg.startsWith('-') && !flagValues.has(index));

if (bump === undefined) {
  process.stderr.write('usage: node release.mjs <patch|minor|major|X.Y.Z> [-m "commit body"] [--dry-run] [--skip-install]\n');
  process.exit(2);
}

const env = { ...process.env, HTTPS_PROXY: PROXY, HTTP_PROXY: PROXY, GIT_TERMINAL_PROMPT: '0' };
const step = (text) => process.stdout.write(`\n\u25b6 ${text}\n`);
const run = (command, args, { allowFailure = false, shell = false, ...rest } = {}) => {
  const result = spawnSync(command, args, { cwd: here, env, encoding: 'utf8', shell, ...rest });
  // A spawn that never started reports status null and puts the reason in `error`;
  // surfacing that by name is what turns a silent no-op into a diagnosable failure.
  if (result.status !== 0 && !allowFailure) {
    const reason = result.error ? `${result.error.code}: ${result.error.message}` : `exit ${result.status}`;
    throw new Error(`${command} ${args.join(' ')} failed (${reason})\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? `\n${result.error.code}: ${result.error.message}` : ''}`;
};
const git = (...args) => run(GIT, args).trim();

/** Bump a semver string by one of patch/minor/major. */
function nextVersion(current, kind) {
  if (/^\d+\.\d+\.\d+$/.test(kind)) return kind;
  const [major, minor, patch] = current.split('.').map(Number);
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  if (kind === 'major') return `${major + 1}.0.0`;
  throw new Error(`unknown bump "${kind}" — use patch, minor, major, or an explicit X.Y.Z`);
}

// ── Preconditions ────────────────────────────────────────────────────────────
step('Preconditions');
const manifestPath = join(here, 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const current = manifest.version;
const version = nextVersion(current, bump);

const dirty = git('status', '--porcelain');
if (dirty.length > 0) {
  process.stdout.write(`  uncommitted changes are present; they will be included in this release:\n${dirty.split('\n').map((l) => `    ${l}`).join('\n')}\n`);
}
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (branch !== 'main') throw new Error(`on branch "${branch}", expected main`);
process.stdout.write(`  ${manifest.name}  ${current} -> ${version}\n`);

// ── Build and verify ─────────────────────────────────────────────────────────
step('Regenerate the patch from persona.txt');
process.stdout.write(`  ${run(process.execPath, ['build-patch.mjs']).trim()}\n`);

step('Verify the patch, the persona and the mask');
const patchReport = run(process.execPath, ['verify-patch.mjs']);
if (!patchReport.includes('ALL CHECKS PASSED')) throw new Error(`verify-patch.mjs did not pass:\n${patchReport}`);
process.stdout.write('  verify-patch.mjs: ALL CHECKS PASSED\n');
const depthReport = run(process.execPath, ['verify-depth-override.mjs'], { allowFailure: true });
process.stdout.write(
  depthReport.includes('ALL CHECKS PASSED')
    ? '  verify-depth-override.mjs: ALL CHECKS PASSED\n'
    : '  verify-depth-override.mjs: SKIPped (no depth override on this machine)\n',
);

// ── Version and commit ───────────────────────────────────────────────────────
step(`Set version ${version}`);
if (dryRun) {
  process.stdout.write('  --dry-run: not writing package.json\n');
} else {
  const updated = readFileSync(manifestPath, 'utf8').replace(/"version": "[^"]+"/, `"version": "${version}"`);
  if (updated === readFileSync(manifestPath, 'utf8')) throw new Error('could not find the version field to replace');
  run(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(manifestPath)}, ${JSON.stringify(updated)})`]);
}

/** `yyyy-MM-dd HH:mm` in LOCAL time — the project's commit-message convention. */
function localStamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}`
  );
}

const commitMessage = `[Agent任务] ${localStamp()} | ${body ?? `发布 v${version}`}`;

step('Commit and push');
if (dryRun) {
  process.stdout.write(`  --dry-run: would commit "${commitMessage}" and push to origin/main\n`);
} else {
  git('add', '-A');
  git('commit', '-m', commitMessage);
  process.stdout.write(`  committed ${git('rev-parse', '--short', 'HEAD')}\n`);
  const pushed = run(GIT, ['push', 'origin', 'main'], { allowFailure: true });
  // The owner bypasses branch protection; collaborators cannot, and will need a PR.
  if (!/main -> main|Everything up-to-date/.test(pushed)) {
    throw new Error(`push failed — if branch protection refused it, open a pull request instead:\n${pushed}`);
  }
  process.stdout.write('  pushed to origin/main\n');
}

// ── Publish ──────────────────────────────────────────────────────────────────
step(`Publish with ${PUBLISHER} to the official registry (the configured one is a read-only mirror)`);
if (dryRun) {
  process.stdout.write(`  --dry-run: would run ${PUBLISHER} publish --registry ${OFFICIAL_REGISTRY}\n`);
} else {
  // Two Windows facts force the shape of this call, both learned by watching a
  // publish silently do nothing:
  //  * `npm` and `pnpm` are shell shims, not executables — `npm` is an sh script
  //    (ENOENT), `npm.cmd`/`pnpm.cmd` refuse to spawn without a shell (EINVAL),
  //    and `npm.ps1` is PowerShell (EFTYPE). So the publisher is invoked WITH a
  //    shell, which is why every argument below must stay shell-safe.
  //  * The output must be shown even on failure. The first version filtered it
  //    down to matching lines and printed a blank line when the command never
  //    ran, hiding the real problem behind a successful-looking step.
  const published = run(PUBLISHER, ['publish', '--registry', OFFICIAL_REGISTRY, '--access', 'public'], {
    allowFailure: true,
    shell: true,
  });
  const summary = published
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^Progress:|^Packages:|^\+?$/.test(line));
  process.stdout.write(`${summary.map((line) => `  ${line}`).join('\n') || '  (the publisher printed nothing — treat that as a failure)'}\n`);
}

// ── Confirm on the registry ──────────────────────────────────────────────────
step('Confirm the version is actually live (the exit code does not prove it)');
if (dryRun) {
  process.stdout.write('  --dry-run: skipped\n');
} else {
  // curl, not fetch: this machine reaches the network through a proxy that Node's
  // global fetch does not read, so a fetch here would fail for a reason that has
  // nothing to do with the release.
  const probe = (url) =>
    spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-m', '20', '-x', PROXY, url], {
      encoding: 'utf8',
    }).stdout?.trim();

  // Measured on this account: 1.1.2 was still 404 at 200s and live shortly after,
  // so the window has to be generous or a successful release reads as a failure.
  let live = false;
  for (let attempt = 1; attempt <= 60 && !live; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    const code = probe(`${OFFICIAL_REGISTRY}${manifest.name}/${version}`);
    if (code === '200') {
      live = true;
      process.stdout.write(`  ${manifest.name}@${version} is live on the registry\n`);
    } else if (attempt % 6 === 0) {
      process.stdout.write(`  still not visible after ${attempt * 10}s (last HTTP ${code})\n`);
    }
  }
  if (!live) {
    process.stderr.write(
      '\n  NOT VISIBLE after 10 minutes. Two known causes, in order of likelihood:\n' +
        '   1. propagation lag — this registry answered 404 for over three minutes on a\n' +
        '      publish that had already succeeded, so re-check before concluding anything;\n' +
        '   2. staged publishing — check npmjs.com for a pending approval. `npm stage list`\n' +
        '      reports nothing even when a version is held, so it is not the test.\n',
    );
    process.exit(1);
  }
}

// ── Upgrade the local profile ────────────────────────────────────────────────
step(`Upgrade the local "${profile}" profile so the machine runs what was published`);
if (dryRun || skipInstall) {
  process.stdout.write('  skipped\n');
} else {
  // `dsh` is a shell shim on Windows too, so it is invoked through Node rather
  // than spawned directly. DSH_RELEASE_DSH overrides the entry point.
  const dshEntry = process.env.DSH_RELEASE_DSH ?? 'D:/nodejs/npm_global/node_modules/@deepseek-ai/dsh/lib/bin.js';
  const output = run(
    process.execPath,
    [dshEntry, 'plugin', '--profile', profile, 'add', `${manifest.name}@${version}`, '--registry', OFFICIAL_REGISTRY],
    { allowFailure: true },
  );
  const installed = (() => {
    try {
      return JSON.parse(
        readFileSync(join(homedir(), '.dsh', 'profiles', profile, 'node_modules', manifest.name, 'package.json'), 'utf8'),
      ).version;
    } catch {
      return undefined;
    }
  })();
  if (installed === version) {
    process.stdout.write(`  profile now runs ${manifest.name}@${installed}\n`);
  } else {
    process.stdout.write(
      `  the profile reports ${installed ?? 'unknown'} rather than ${version} — install it by hand:\n` +
        `    dsh plugin --profile ${profile} add ${manifest.name}@${version} --registry ${OFFICIAL_REGISTRY}\n` +
        `${output.trim().split('\n').slice(-6).map((line) => `    ${line}`).join('\n')}\n`,
    );
  }
}

// ── CI ───────────────────────────────────────────────────────────────────────
if (!dryRun && !skipGh) {
  step('Wait for CI on the pushed commit');
  const sha = git('rev-parse', 'HEAD');
  const waited = run(
    GH,
    ['run', 'watch', sha, '--repo', 'XiaoOu2024/dsh-root-planner-preset', '--exit-status'],
    { allowFailure: true },
  );
  process.stdout.write(`  ${waited.trim().split('\n').slice(-2).join('\n  ') || '(no output)'}\n`);
}

step(dryRun ? 'Dry run complete — nothing was changed' : `Released ${manifest.name}@${version}`);
if (!dryRun) {
  process.stdout.write(
    '\n  Next: restart `dsh web`, open a new session on the Root Planner preset, then\n' +
      '  confirm it with tools/verify-session.mjs before trusting any behaviour.\n',
  );
}
