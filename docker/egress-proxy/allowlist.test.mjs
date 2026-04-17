import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { compileAllowlist } from "./allowlist.mjs";

describe("compileAllowlist — exact matches", () => {
  it("matches an exact hostname, case-insensitively", () => {
    const m = compileAllowlist(["api.openai.com"]);
    assert.equal(m("api.openai.com"), true);
    assert.equal(m("API.OpenAI.Com"), true);
    assert.equal(m("other.openai.com"), false);
  });

  it("strips a trailing dot on the input (FQDN form)", () => {
    const m = compileAllowlist(["api.openai.com"]);
    assert.equal(m("api.openai.com."), true);
  });

  it("strips a trailing dot on the pattern too", () => {
    const m = compileAllowlist(["api.openai.com."]);
    assert.equal(m("api.openai.com"), true);
  });

  it("returns false for the empty string", () => {
    const m = compileAllowlist(["api.openai.com"]);
    assert.equal(m(""), false);
  });

  it("rejects hostnames not in the list", () => {
    const m = compileAllowlist(["api.openai.com"]);
    assert.equal(m("evil.example.org"), false);
    assert.equal(m("api.openai.com.evil.example.org"), false);
  });
});

describe("compileAllowlist — wildcard prefixes", () => {
  it("matches any subdomain at any depth, but NOT the apex", () => {
    const m = compileAllowlist(["*.googleapis.com"]);
    assert.equal(m("maps.googleapis.com"), true);
    assert.equal(m("a.b.c.googleapis.com"), true);
    // The apex is explicitly excluded — operators must list it separately.
    assert.equal(m("googleapis.com"), false);
  });

  it("doesn't match an unrelated suffix that happens to share letters", () => {
    const m = compileAllowlist(["*.example.com"]);
    // Attacker domain containing "example.com" as a label: the suffix
    // check must NOT match because the match suffix is ".example.com"
    // which isn't literally present at the right boundary.
    assert.equal(m("myexample.com"), false);
    assert.equal(m("example.com.evil.net"), false);
  });

  it("handles multiple wildcards in the config", () => {
    const m = compileAllowlist(["*.googleapis.com", "*.amazonaws.com"]);
    assert.equal(m("s3.us-east-1.amazonaws.com"), true);
    assert.equal(m("maps.googleapis.com"), true);
    assert.equal(m("api.openai.com"), false);
  });

  it("combines exact and wildcard patterns", () => {
    const m = compileAllowlist(["openai.com", "*.openai.com"]);
    assert.equal(m("openai.com"), true); // exact
    assert.equal(m("api.openai.com"), true); // wildcard
    assert.equal(m("other.org"), false);
  });
});

describe("compileAllowlist — edge cases", () => {
  it("returns false on an empty config", () => {
    const m = compileAllowlist([]);
    assert.equal(m("api.openai.com"), false);
    assert.equal(m("anything"), false);
  });

  it("skips empty string entries in the config", () => {
    const m = compileAllowlist(["", "api.openai.com", ""]);
    assert.equal(m("api.openai.com"), true);
  });

  it("treats whitespace-surrounded entries as trimmed", () => {
    const m = compileAllowlist(["  api.openai.com  "]);
    assert.equal(m("api.openai.com"), true);
  });
});
