#!/usr/bin/env node
/**
 * Require the published market index to list this package version at the
 * release commit. Dependency-free; used by the Plugin index workflow.
 */
import fs from "node:fs";

const indexUrl =
  process.env.PLUGIN_INDEX_URL ??
  "https://raw.githubusercontent.com/douglarek/dsh-plugin-index/main/index.json";
const packageFile = new URL("../package.json", import.meta.url);
const pkg = JSON.parse(fs.readFileSync(packageFile, "utf8"));
const commit = (process.argv[2] ?? process.env.GITHUB_SHA ?? "").trim();

function fail(message) {
  console.error(`Index check failed: ${message}`);
  console.error(
    `Update ${indexUrl} with ${pkg.name}@${pkg.version} from commit ${commit || "<commit>"} and push it.`,
  );
  process.exit(1);
}

if (!/^[0-9a-f]{40}$/.test(commit)) {
  fail("pass a full 40-character lowercase commit SHA or run in GitHub Actions");
}

const response = await fetch(indexUrl, {
  headers: { "cache-control": "no-cache" },
});
if (!response.ok) fail(`cannot read index (HTTP ${response.status})`);

let index;
try {
  index = await response.json();
} catch (error) {
  fail(`index is not valid JSON: ${error.message}`);
}

const plugin = Array.isArray(index?.plugins)
  ? index.plugins.find((entry) => entry?.name === pkg.name)
  : undefined;
if (plugin === undefined) fail(`index does not list ${pkg.name}`);

const version = Array.isArray(plugin.versions)
  ? plugin.versions.find((entry) => entry?.version === pkg.version)
  : undefined;
if (version === undefined) {
  fail(`index does not list version ${pkg.version}`);
}
if (version.source?.type !== "git") {
  fail(`index version ${pkg.version} is not a Git source`);
}
if (version.source.commit !== commit) {
  fail(
    `index version ${pkg.version} points at ${version.source.commit}, expected ${commit}`,
  );
}

console.log(
  `Index OK: ${pkg.name}@${pkg.version} -> ${version.source.commit}`,
);
