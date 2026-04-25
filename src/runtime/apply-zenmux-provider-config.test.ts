import { describe, expect, it } from "vitest";

import { buildZenMuxProviderConfig } from "../../docker/apply-zenmux-provider-config.mjs";

describe("apply-zenmux-provider-config", () => {
  it("maps ZenMux model metadata + pricing into an OpenClaw provider block", () => {
    const provider = buildZenMuxProviderConfig({
      baseUrl: "https://zenmux.ai/api/v1",
      apiKey: "sk-test",
      modelId: "moonshot/kimi-k2.6",
      catalog: {
        data: [
          {
            id: "moonshot/kimi-k2.6",
            display_name: "Moonshot: Kimi K2.6",
            input_modalities: ["text", "image", "file"],
            capabilities: { reasoning: false },
            context_length: 262144,
            pricings: {
              prompt: [
                { value: 0.6, unit: "perMTokens", currency: "USD" },
                {
                  value: 1.2,
                  unit: "perMTokens",
                  currency: "USD",
                  conditions: {
                    prompt_tokens: { unit: "kTokens", gte: 200 },
                  },
                },
              ],
              completion: [
                { value: 3, unit: "perMTokens", currency: "USD" },
              ],
              input_cache_read: [
                { value: 0.1, unit: "perMTokens", currency: "USD" },
              ],
              input_cache_write_5_min: [
                { value: 0.2, unit: "perMTokens", currency: "USD" },
              ],
              request: [{ value: 0.01, unit: "perCount", currency: "USD" }],
              internal_reasoning: [
                { value: 5, unit: "perMTokens", currency: "USD" },
              ],
            },
          },
        ],
      },
    });

    expect(provider).toMatchObject({
      baseUrl: "https://zenmux.ai/api/v1",
      apiKey: "sk-test",
      api: "openai-completions",
      models: [
        {
          id: "moonshot/kimi-k2.6",
          name: "Moonshot: Kimi K2.6",
          reasoning: false,
          input: ["text", "image"],
          cost: {
            input: 0.6,
            output: 3,
            cacheRead: 0.1,
            cacheWrite: 0.2,
          },
          contextWindow: 262144,
          maxTokens: 262144,
        },
      ],
    });
  });

  it("preserves provider/model ids for DeepSeek v4 models routed through ZenMux", () => {
    const provider = buildZenMuxProviderConfig({
      baseUrl: "https://zenmux.ai/api/v1",
      apiKey: "sk-test",
      modelId: "deepseek/deepseek-v4-pro",
      catalog: {
        data: [
          {
            id: "deepseek/deepseek-v4-pro",
            display_name: "DeepSeek: V4 Pro",
            input_modalities: ["text"],
            capabilities: { reasoning: true },
            context_length: 1048576,
            pricings: {
              prompt: [
                { value: 1.74, unit: "perMTokens", currency: "USD" },
              ],
              completion: [
                { value: 3.48, unit: "perMTokens", currency: "USD" },
              ],
              input_cache_read: [
                { value: 0.145, unit: "perMTokens", currency: "USD" },
              ],
            },
          },
        ],
      },
    });

    expect(provider).toMatchObject({
      models: [
        {
          id: "deepseek/deepseek-v4-pro",
          name: "DeepSeek: V4 Pro",
          reasoning: true,
          input: ["text"],
          contextWindow: 1048576,
          maxTokens: 1048576,
          cost: {
            input: 1.74,
            output: 3.48,
            cacheRead: 0.145,
            cacheWrite: 0,
          },
        },
      ],
    });
  });

  it("maps legacy portal Claude aliases to catalog model ids", () => {
    const provider = buildZenMuxProviderConfig({
      baseUrl: "https://zenmux.ai/api/v1",
      apiKey: "sk-test",
      modelId: "anthropic/claude-opus-4-7",
      catalog: {
        data: [
          {
            id: "anthropic/claude-opus-4.7",
            display_name: "Anthropic: Claude Opus 4.7",
            input_modalities: ["text", "image"],
            capabilities: { reasoning: true },
            context_length: 200000,
            pricings: {
              prompt: [
                { value: 5, unit: "perMTokens", currency: "USD" },
              ],
              completion: [
                { value: 25, unit: "perMTokens", currency: "USD" },
              ],
            },
          },
        ],
      },
    });

    expect(provider).toMatchObject({
      models: [
        {
          id: "anthropic/claude-opus-4.7",
          name: "Anthropic: Claude Opus 4.7",
          reasoning: true,
          input: ["text", "image"],
        },
      ],
    });
  });
});
