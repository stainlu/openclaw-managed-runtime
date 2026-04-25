import { describe, expect, it } from "vitest";

import { DockerContainerRuntime } from "./docker.js";
import type { Container } from "./container.js";

function dockerLogBuffer(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

describe("DockerContainerRuntime", () => {
  it("fails readiness immediately when the container exited", async () => {
    const runtime = new DockerContainerRuntime() as unknown as DockerContainerRuntime & {
      docker: {
        getContainer(id: string): {
          inspect(): Promise<unknown>;
          logs(): Promise<Buffer>;
        };
      };
    };
    runtime.docker = {
      getContainer() {
        return {
          async inspect() {
            return {
              State: {
                Running: false,
                Status: "exited",
                ExitCode: 1,
                OOMKilled: false,
                Error: "",
              },
            };
          },
          async logs() {
            return dockerLogBuffer("ZenMux model not found in /models catalog\n");
          },
        };
      },
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("fetch failed");
    }) as typeof fetch;

    try {
      const started = Date.now();
      let thrown: unknown;
      try {
        await runtime.waitForReady(
          {
            id: "cnt_dead",
            name: "openclaw-agt-dead",
            baseUrl: "http://openclaw-agt-dead:18789",
            token: "tok",
          } satisfies Container,
          600_000,
        );
      } catch (err) {
        thrown = err;
      }

      expect(Date.now() - started).toBeLessThan(200);
      expect(thrown).toBeInstanceOf(Error);
      expect(String(thrown)).toContain("container openclaw-agt-dead exited before ready");
      expect(String(thrown)).toContain("exit_code=1");
      expect(String(thrown)).toContain("ZenMux model not found in /models catalog");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
