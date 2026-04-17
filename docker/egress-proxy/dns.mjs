// Minimal DNS wire-format parser + NXDOMAIN synthesizer. Scope is
// narrow: we parse just enough of an incoming query to extract the
// first question's name, decide allow/deny, and either forward the
// original query to the upstream resolver or return an NXDOMAIN
// response. No zone data, no caching, no DNSSEC.
//
// RFC 1035 message format:
//   HEADER (12 bytes): id | flags | qdcount | ancount | nscount | arcount
//   QUESTION * qdcount: name (length-prefixed labels + null) | qtype (2) | qclass (2)
//
// Labels are length-prefixed; 0x00 terminates the name. Message
// compression (0xC0 pointers) CAN appear in questions though it's
// extremely rare — we still handle it defensively.

/**
 * Parse the first question's name from a DNS query buffer.
 * Returns undefined on malformed input; we treat any parse error
 * as "deny" at the caller.
 *
 * @param {Buffer} msg
 * @returns {string | undefined}
 */
export function parseFirstQuestionName(msg) {
  if (msg.length < 12) return undefined;
  const qdcount = msg.readUInt16BE(4);
  if (qdcount < 1) return undefined;
  let offset = 12;
  const labels = [];
  // Hard-cap iteration to prevent infinite loops on malicious input.
  for (let i = 0; i < 128; i++) {
    if (offset >= msg.length) return undefined;
    const len = msg[offset];
    if (len === 0) {
      offset += 1;
      return labels.length === 0 ? "." : labels.join(".");
    }
    if ((len & 0xc0) === 0xc0) {
      // Compression pointer. In a question this is unusual; follow once
      // and treat a deeper chain as malformed.
      if (offset + 1 >= msg.length) return undefined;
      const ptr = ((len & 0x3f) << 8) | msg[offset + 1];
      if (ptr >= offset) return undefined; // must point backwards
      offset = ptr;
      continue;
    }
    if (len > 63) return undefined; // label length capped at 63
    if (offset + 1 + len > msg.length) return undefined;
    labels.push(msg.slice(offset + 1, offset + 1 + len).toString("ascii"));
    offset += 1 + len;
  }
  return undefined;
}

/**
 * Synthesize a minimal NXDOMAIN response echoing the original query's
 * id + question section. Standards-compliant enough that resolvers
 * (getaddrinfo, dig) interpret it as "this name does not exist" and
 * give up rather than retrying forever.
 *
 * @param {Buffer} query
 * @returns {Buffer}
 */
export function synthesizeNxdomain(query) {
  if (query.length < 12) return Buffer.alloc(0);
  // Find the end of the question section so we can copy it into the
  // response verbatim. We parsed qdcount=1 questions in the caller;
  // we only echo the first one here.
  let offset = 12;
  let labelSafetyCap = 0;
  while (offset < query.length && labelSafetyCap < 128) {
    const len = query[offset];
    if (len === 0) {
      offset += 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      offset += 2;
      break;
    }
    if (offset + 1 + len > query.length) {
      // Malformed — best-effort echo of the whole buffer.
      offset = query.length;
      break;
    }
    offset += 1 + len;
    labelSafetyCap += 1;
  }
  // qtype (2) + qclass (2).
  const questionEnd = Math.min(offset + 4, query.length);
  const resp = Buffer.alloc(questionEnd);
  query.copy(resp, 0, 0, questionEnd);
  // Flags: QR=1 (response), OPCODE=0, AA=0, TC=0, RD preserved, RA=1,
  // Z=0, RCODE=3 (NXDOMAIN).
  // Read original flags to preserve RD (recursion desired) echo.
  const origFlags = resp.readUInt16BE(2);
  const rd = (origFlags >> 8) & 0x01;
  const newFlags = 0x8000 | (rd << 8) | 0x0080 | 0x0003;
  resp.writeUInt16BE(newFlags, 2);
  // qdcount stays at 1 (we echoed the question); ancount/nscount/arcount = 0.
  resp.writeUInt16BE(1, 4);
  resp.writeUInt16BE(0, 6);
  resp.writeUInt16BE(0, 8);
  resp.writeUInt16BE(0, 10);
  return resp;
}
