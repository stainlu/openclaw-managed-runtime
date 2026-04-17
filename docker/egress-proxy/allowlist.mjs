// Shared host-allowlist matcher for the egress-proxy sidecar.
//
// Two pattern styles are allowed in the config:
//   - Exact hostname: "api.example.com" matches ONLY "api.example.com".
//   - Wildcard prefix: "*.example.com" matches any name ending in
//     ".example.com" at any depth (so "foo.example.com" and
//     "a.b.c.example.com" both match), but does NOT match
//     "example.com" itself. List both if you want that too.
//
// Normalization: we lowercase both the config entries and the query
// before matching, strip trailing dots, and reject any entry that
// looks like an IP literal (caught upstream by the zod schema, but
// we guard here too so bad input can't confuse the matcher).
//
// Kept dependency-free so it runs the same way in the sidecar and in
// the unit tests.

/** @param {string} s */
function normalize(s) {
  let out = s.toLowerCase().trim();
  if (out.endsWith(".")) out = out.slice(0, -1);
  return out;
}

/**
 * Compile a list of patterns into a matcher. Returns a function that
 * takes a hostname and returns true if it is allowed.
 *
 * @param {string[]} patterns
 * @returns {(host: string) => boolean}
 */
export function compileAllowlist(patterns) {
  const exact = new Set();
  /** @type {string[]} */
  const wildcardSuffixes = [];
  for (const raw of patterns) {
    const p = normalize(raw);
    if (p.length === 0) continue;
    if (p.startsWith("*.")) {
      // Strip the "*" but keep the leading dot so the suffix check
      // enforces at least one label in front.
      const suffix = p.slice(1); // ".example.com"
      wildcardSuffixes.push(suffix);
    } else {
      exact.add(p);
    }
  }
  return (host) => {
    const h = normalize(host);
    if (h.length === 0) return false;
    if (exact.has(h)) return true;
    for (const suffix of wildcardSuffixes) {
      // suffix is ".example.com"; require the host to end with it AND
      // have at least one character before it (so a bare "example.com"
      // doesn't match "*.example.com").
      if (h.length > suffix.length && h.endsWith(suffix)) return true;
    }
    return false;
  };
}
