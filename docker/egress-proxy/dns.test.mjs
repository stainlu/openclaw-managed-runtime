import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { parseFirstQuestionName, synthesizeNxdomain } from "./dns.mjs";

/**
 * Build a minimal DNS query for a given hostname (single A question).
 * Header flags: standard query, RD=1. Matches what `dig` / getaddrinfo emit.
 */
function buildQuery(name, { id = 0x1234, qtype = 1 /* A */ } = {}) {
  const labels = name.split(".").filter((l) => l.length > 0);
  let nameBytes = Buffer.alloc(0);
  for (const label of labels) {
    nameBytes = Buffer.concat([
      nameBytes,
      Buffer.from([label.length]),
      Buffer.from(label, "ascii"),
    ]);
  }
  nameBytes = Buffer.concat([nameBytes, Buffer.from([0])]);

  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0100, 2); // standard query, RD=1
  header.writeUInt16BE(1, 4); // qdcount
  header.writeUInt16BE(0, 6); // ancount
  header.writeUInt16BE(0, 8); // nscount
  header.writeUInt16BE(0, 10); // arcount

  const question = Buffer.alloc(4);
  question.writeUInt16BE(qtype, 0);
  question.writeUInt16BE(1, 2); // IN class

  return Buffer.concat([header, nameBytes, question]);
}

describe("parseFirstQuestionName", () => {
  it("extracts a simple two-label name", () => {
    const q = buildQuery("example.com");
    assert.equal(parseFirstQuestionName(q), "example.com");
  });

  it("extracts a deeply-nested name", () => {
    const q = buildQuery("a.b.c.d.example.com");
    assert.equal(parseFirstQuestionName(q), "a.b.c.d.example.com");
  });

  it("handles a single-label name", () => {
    const q = buildQuery("localhost");
    assert.equal(parseFirstQuestionName(q), "localhost");
  });

  it("returns undefined on too-short buffers", () => {
    assert.equal(parseFirstQuestionName(Buffer.alloc(4)), undefined);
    assert.equal(parseFirstQuestionName(Buffer.alloc(11)), undefined);
  });

  it("returns undefined when qdcount is zero", () => {
    const q = buildQuery("example.com");
    q.writeUInt16BE(0, 4); // zero out qdcount
    assert.equal(parseFirstQuestionName(q), undefined);
  });

  it("returns undefined when the buffer is truncated mid-label", () => {
    // Build a query and then slice off the terminator + question
    // section so the label length claims more bytes than exist.
    const q = buildQuery("example.com");
    const truncated = q.slice(0, 15); // header + partial label
    assert.equal(parseFirstQuestionName(truncated), undefined);
  });

  it("returns undefined on a label longer than the DNS 63-byte cap", () => {
    // Hand-craft: header + a single label with length 0xFF (>63).
    const buf = Buffer.alloc(12 + 1 + 0xff + 1 + 4);
    buf.writeUInt16BE(0, 0);
    buf.writeUInt16BE(0x0100, 2);
    buf.writeUInt16BE(1, 4);
    buf.writeUInt8(0xff, 12);
    // Rest is zeros — the parser must reject the oversized length.
    assert.equal(parseFirstQuestionName(buf), undefined);
  });
});

describe("synthesizeNxdomain", () => {
  it("produces a parseable NXDOMAIN response with matching transaction id", () => {
    const query = buildQuery("blocked.example.org", { id: 0xbeef });
    const resp = synthesizeNxdomain(query);
    assert.ok(resp.length >= 12, "response must at least have a header");
    // Transaction id echoed.
    assert.equal(resp.readUInt16BE(0), 0xbeef);
    // Flags: QR=1 (bit 15 set), RCODE=3 (low nibble).
    const flags = resp.readUInt16BE(2);
    assert.equal((flags & 0x8000) !== 0, true, "QR bit must be set");
    assert.equal(flags & 0x000f, 3, "RCODE must be NXDOMAIN=3");
    // qdcount echoed (we put back the question section).
    assert.equal(resp.readUInt16BE(4), 1);
    // ancount / nscount / arcount zeroed.
    assert.equal(resp.readUInt16BE(6), 0);
    assert.equal(resp.readUInt16BE(8), 0);
    assert.equal(resp.readUInt16BE(10), 0);
  });

  it("preserves RD (recursion desired) so the resolver's session handle stays sane", () => {
    const query = buildQuery("blocked.example.org");
    const resp = synthesizeNxdomain(query);
    const flags = resp.readUInt16BE(2);
    assert.equal((flags & 0x0100) !== 0, true, "RD bit must be preserved");
  });

  it("returns an empty buffer on a query smaller than a DNS header", () => {
    const resp = synthesizeNxdomain(Buffer.alloc(4));
    assert.equal(resp.length, 0);
  });

  it("round-trips through our own parser", () => {
    // The synthesized response must itself be parseable as a DNS
    // message whose question section echoes the original name.
    const query = buildQuery("blocked.example.org");
    const resp = synthesizeNxdomain(query);
    assert.equal(parseFirstQuestionName(resp), "blocked.example.org");
  });
});
