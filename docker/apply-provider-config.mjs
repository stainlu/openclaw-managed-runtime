#!/usr/bin/env node
// apply-provider-config.mjs — populate models.providers.<id> in the generated
// openclaw.json by calling the bundled openclaw extension's catalog-builder
// function. Replaces the hand-mirrored PROVIDER_BLOCK_JSON hack in
// docker/entrypoint.sh: the script now reads upstream's actual catalog
// at container start, so prices + model IDs track upstream with zero drift.
//
// When upstream's moonshot plugin updates its catalog (new models, revised
// prices — e.g. openclaw/openclaw#67928), we pick up the change on the next
// image rebuild with no downstream edit required.
//
// Usage:
//   node apply-provider-config.mjs <config-path> <provider-id>
//
// Supported provider ids:
//   - moonshot — via buildMoonshotProvider() from the bundled extension
//
// Unknown or Category A provider ids are a no-op. Category A plugins
// (anthropic, openai, google, xai, mistral, openrouter, amazon-bedrock)
// auto-register their catalog at plugin-load time and need no help from here.
//
// Why not call applyMoonshotConfig / applyMoonshotProviderConfig instead?
// Those helpers only populate the DEFAULT model (kimi-k2.5), not the full
// four-model catalog. buildMoonshotProvider() returns the full provider
// block verbatim, so agents that opt into kimi-k2-thinking, kimi-k2-turbo,
// etc. resolve correctly on first boot without any extra wiring.
//
// Why not import openclaw/dist/extensions/... via the package's exports?
// The openclaw package's package.json "exports" field whitelists only the
// plugin-sdk subpaths; extensions/* is not exported. We use the literal
// install path (file:///usr/local/lib/node_modules/openclaw/dist/...)
// instead. This is stable because the openclaw npm package ships the dist/
// tree in its published files list (confirmed in 2026.4.11).

import { readFileSync, writeFileSync } from "node:fs";

const OPENCLAW_DIST_ROOT =
  "file:///usr/local/lib/node_modules/openclaw/dist";

// providerId → {module subpath, factory export name, post-mutation hook?}
// Extend when adding more Category B providers. Each entry's factory must
// return a ModelProviderConfig-shaped object that we drop into
// config.models.providers[providerId].
const PROVIDER_CATALOGS = {
  moonshot: {
    module: "extensions/moonshot/provider-catalog.js",
    factory: "buildMoonshotProvider",
  },
};

const [, , configPath, providerId] = process.argv;
if (!configPath || !providerId) {
  process.stderr.write(
    "usage: apply-provider-config.mjs <config-path> <provider-id>\n",
  );
  process.exit(1);
}

const entry = PROVIDER_CATALOGS[providerId];
if (!entry) {
  process.stdout.write(
    `[apply-provider-config] ${providerId} is not a registered Category B provider; no-op\n`,
  );
  process.exit(0);
}

let catalogModule;
try {
  catalogModule = await import(`${OPENCLAW_DIST_ROOT}/${entry.module}`);
} catch (err) {
  process.stderr.write(
    `[apply-provider-config] failed to import ${entry.module} for ${providerId}: ${err.message}\n`,
  );
  process.exit(1);
}

const factory = catalogModule[entry.factory];
if (typeof factory !== "function") {
  process.stderr.write(
    `[apply-provider-config] expected ${entry.factory} from ${entry.module}, got ${typeof factory}\n`,
  );
  process.exit(1);
}

let providerConfig;
try {
  providerConfig = factory();
} catch (err) {
  process.stderr.write(
    `[apply-provider-config] ${entry.factory}() threw: ${err.message}\n`,
  );
  process.exit(1);
}

if (!providerConfig || typeof providerConfig !== "object") {
  process.stderr.write(
    `[apply-provider-config] ${entry.factory}() returned non-object\n`,
  );
  process.exit(1);
}

let cfg;
try {
  cfg = JSON.parse(readFileSync(configPath, "utf8"));
} catch (err) {
  process.stderr.write(
    `[apply-provider-config] failed to read/parse ${configPath}: ${err.message}\n`,
  );
  process.exit(1);
}

cfg.models = cfg.models ?? {};
cfg.models.mode = cfg.models.mode ?? "merge";
cfg.models.providers = cfg.models.providers ?? {};
cfg.models.providers[providerId] = providerConfig;

// Price-override pass. openclaw's bundled plugin catalogs ship with
// real prices for most Category A providers (Anthropic, OpenAI, Google,
// xAI, Mistral, Bedrock) but $0 for Moonshot (tracked in
// openclaw/openclaw#67928). We carry a small JSON table of real-world
// $/1M-token prices in provider-prices.json; if the provider built
// above has an entry, patch the cost block on each matching model so
// cost.total comes out non-zero. When openclaw ships real prices
// upstream, delete the matching provider block from the JSON to defer
// to upstream without any other change.
const PRICES_PATH = "/opt/openclaw-plugins/provider-prices.json";
let overrides;
try {
  overrides = JSON.parse(readFileSync(PRICES_PATH, "utf8"));
} catch (err) {
  if (err.code !== "ENOENT") {
    process.stderr.write(
      `[apply-provider-config] warning: couldn't read price overrides: ${err.message}\n`,
    );
  }
}
if (overrides && overrides[providerId] && Array.isArray(providerConfig.models)) {
  const table = overrides[providerId];
  let patched = 0;
  for (const model of providerConfig.models) {
    const row = table[model.id];
    if (!row) continue;
    model.cost = {
      input: row.input ?? 0,
      output: row.output ?? 0,
      cacheRead: row.cacheRead ?? 0,
      cacheWrite: row.cacheWrite ?? 0,
    };
    patched++;
  }
  if (patched > 0) {
    process.stdout.write(
      `[apply-provider-config] applied price overrides to ${patched} ${providerId} model(s) from provider-prices.json\n`,
    );
  }
}

writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf8");
process.stdout.write(
  `[apply-provider-config] populated models.providers.${providerId} with ${providerConfig.models?.length ?? 0} model(s) from bundled openclaw catalog\n`,
);
