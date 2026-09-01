#!/usr/bin/env node
/**
 * Publish this package to GitHub Packages as @dashverse/openpanel-web.
 *
 * The workspace package stays @openpanel/web at a -local version so the
 * monorepo keeps resolving it through `workspace:*`. Publishing swaps in a
 * standalone manifest for the duration of the build and the publish, then puts
 * the workspace one back.
 *
 * The swap happens BEFORE the build on purpose: tsup inlines
 * process.env.WEB_VERSION from this package.json, so the bundle has to be
 * built while the file already carries the version it ships under.
 *
 * Dependencies are dropped from the published manifest because tsup bundles
 * rrweb and every @openpanel/* package into dist (noExternal in
 * tsup.config.ts), so the tarball is self-contained.
 *
 * Auth: npm reads the token for npm.pkg.github.com from ~/.npmrc
 *   //npm.pkg.github.com/:_authToken=<token with write:packages>
 *
 * Usage:
 *   node scripts/publish-github.mjs 1.5.0 --dry-run
 *   node scripts/publish-github.mjs 1.5.0
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLISHED_NAME = '@dashverse/openpanel-web';
const REGISTRY = 'https://npm.pkg.github.com';

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(packageDir, 'package.json');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const version = args.find((arg) => !arg.startsWith('-'));

if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(
    'usage: node scripts/publish-github.mjs <version> [--dry-run]\n' +
      'example: node scripts/publish-github.mjs 1.5.0 --dry-run',
  );
  process.exit(1);
}

/**
 * @param {string} command
 * @param {string[]} commandArgs
 */
const run = (command, commandArgs) =>
  execFileSync(command, commandArgs, { cwd: packageDir, stdio: 'inherit' });

const workspaceManifest = readFileSync(manifestPath, 'utf-8');

const publishedManifest = {
  name: PUBLISHED_NAME,
  version,
  description: 'OpenPanel web SDK with session replay, Dashverse fork.',
  main: 'dist/index.js',
  module: 'dist/index.mjs',
  types: 'dist/index.d.ts',
  files: ['dist'],
  license: 'AGPL-3.0',
};

try {
  writeFileSync(
    manifestPath,
    `${JSON.stringify(publishedManifest, null, 2)}\n`,
  );
  rmSync(join(packageDir, 'dist'), { recursive: true, force: true });
  console.log(`Building ${PUBLISHED_NAME}@${version}`);
  run('node_modules/.bin/tsup', []);
  console.log(`Publishing ${PUBLISHED_NAME}@${version} to ${REGISTRY}`);
  run('npm', [
    'publish',
    '--registry',
    REGISTRY,
    ...(dryRun ? ['--dry-run'] : []),
  ]);
} finally {
  writeFileSync(manifestPath, workspaceManifest);
}
