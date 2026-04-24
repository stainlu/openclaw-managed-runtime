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
//   - deepseek — via buildDeepSeekProvider() from the bundled extension
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
import { pathToFileURL } from "node:url";

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
  deepseek: {
    module: "extensions/deepseek/provider-catalog.js",
    factory: "buildDeepSeekProvider",
  },
};

function toCost(row) {
  if (!row || typeof row !== "object") return undefined;
  const cost = row.cost && typeof row.cost === "object" ? row.cost : row;
  return {
    input: cost.input ?? 0,
    output: cost.output ?? 0,
    cacheRead: cost.cacheRead ?? 0,
    cacheWrite: cost.cacheWrite ?? 0,
  };
}

function buildSyntheticModel(modelId, row, providerConfig) {
  if (!row || typeof row !== "object" || typeof row.name !== "string") {
    return undefined;
  }
  const fallback = Array.isArray(providerConfig.models) ? providerConfig.models[0] : undefined;
  return {
    id: modelId,
    name: row.name,
    reasoning: row.reasoning ?? fallback?.reasoning ?? false,
    input: Array.isArray(row.modalities) && row.modalities.length > 0
      ? row.modalities.filter((v) => v === "text" || v === "image")
      : (fallback?.input ?? ["text"]),
    cost: toCost(row),
    contextWindow: row.contextWindow ?? fallback?.contextWindow ?? 262144,
    maxTokens: row.maxTokens ?? fallback?.maxTokens ?? row.contextWindow ?? fallback?.contextWindow ?? 262144,
  };
}

export function applyPriceOverrides(providerId, providerConfig, overrides, logger = () => {}) {
  if (!overrides || !overrides[providerId] || !Array.isArray(providerConfig.models)) {
    return providerConfig;
  }
  const table = overrides[providerId];
  let patched = 0;
  let injected = 0;
  const knownIds = new Set(providerConfig.models.map((m) => m.id));
  for (const model of providerConfig.models) {
    const row = table[model.id];
    if (!row) continue;
    model.cost = toCost(row);
    patched++;
  }
  if (patched > 0) {
    logger(
      `[apply-provider-config] applied price overrides to ${patched} ${providerId} model(s) from provider-prices.json\n`,
    );
  }
  const skipped = [];
  for (const [modelId, row] of Object.entries(table)) {
    if (knownIds.has(modelId)) continue;
    const synthetic = buildSyntheticModel(modelId, row, providerConfig);
    if (!synthetic) {
      skipped.push(modelId);
      continue;
    }
    providerConfig.models.push(synthetic);
    injected++;
  }
  if (injected > 0) {
    logger(
      `[apply-provider-config] injected ${injected} missing ${providerId} model(s) from provider-prices.json\n`,
    );
  }
  if (skipped.length > 0) {
    logger(
      `[apply-provider-config] skipped ${skipped.length} missing ${providerId} model(s) from provider-prices.json because they do not include the full metadata required for an inline model: ${skipped.join(", ")}\n`,
    );
  }
  return providerConfig;
}

// Price-override pass. openclaw's bundled plugin catalogs ship with
// real prices for most Category A providers (Anthropic, OpenAI, Google,
// xAI, Mistral, Bedrock). We carry a small JSON table of provider-side
// catalog patches in provider-prices.json for any bundled provider catalog
// that still lags upstream docs (today: Moonshot + DeepSeek direct-provider
// v4 ids). If the provider built above has an entry, patch the cost block on
// each matching model and inject any missing models so cost.total stays real
// and newly-documented ids resolve immediately. When openclaw ships the same
// prices/catalog upstream, delete the matching provider block from the JSON
// to defer to upstream without any other change.
const PRICES_PATH = process.env.OPENCLAW_PROVIDER_PRICES_PATH || "/opt/openclaw-plugins/provider-prices.json";

export async function main(argv = process.argv) {
  const [, , configPath, providerId] = argv;
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

  applyPriceOverrides(providerId, providerConfig, overrides, (line) => {
    process.stdout.write(line);
  });

  writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf8");
  process.stdout.write(
    `[apply-provider-config] populated models.providers.${providerId} with ${providerConfig.models?.length ?? 0} model(s) from bundled openclaw catalog\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
