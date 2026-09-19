const CANDIDATE = 'a=candidate:';
// a=candidate:<foundation> <component> <transport> <priority> <address> <port> typ <type> [...extensions]
const ADDRESS = 4;

interface Candidate {
  fields: string[];
  transport: string;
  address: string;
  port: string;
  type: string;
}

// Replaces the answer's candidates with the ones a remote client can reach: private and mDNS
// addresses are dropped, host candidates are dropped once a NAT-traversing candidate exists, and
// the survivors are readdressed to `advertise`. Pass an empty `advertise` to keep the addresses.
// `failOpen` returns the description untouched when nothing survives, trading the address leak for
// a connection that can still complete.
export function rewriteAnswerCandidates(sdp: string, advertise: string, failOpen = true): string {
  const lines = sdp.split(/\r?\n/u);
  const candidates: [index: number, candidate: Candidate][] = [];
  lines.forEach((line, index) => {
    const candidate = parseCandidate(line);
    if (candidate) candidates.push([index, candidate]);
  });
  if (candidates.length === 0) return sdp;

  const routable = candidates.filter(([, candidate]) => !isPrivateAddress(candidate.address));
  const hasNonHost = routable.some(([, candidate]) => candidate.type !== 'host');

  const kept = new Map<number, string>();
  const seen = new Set<string>();
  for (const [index, candidate] of routable) {
    if (hasNonHost && candidate.type === 'host') continue;

    const fields = candidate.fields.slice();
    if (advertise && candidate.type !== 'host') fields[ADDRESS] = advertise;
    scrubRelated(fields);

    // Readdressing collapses the per-interface candidates into duplicates of one transport address.
    const key = [candidate.transport, fields[ADDRESS], candidate.port, candidate.type].join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    kept.set(index, CANDIDATE + fields.join(' '));
  }
  if (kept.size === 0 && failOpen) return sdp;

  const out: string[] = [];
  lines.forEach((line, index) => {
    const rewritten = kept.get(index);
    if (rewritten !== undefined) out.push(rewritten);
    else if (!line.startsWith(CANDIDATE)) out.push(line);
  });
  return out.join('\r\n');
}

// Removes every candidate from an offer so the upstream server never sees the client's addresses.
export function stripOfferCandidates(sdp: string): string {
  return sdp
    .split(/\r?\n/u)
    .filter((line) => !line.startsWith(CANDIDATE))
    .join('\r\n');
}

function parseCandidate(line: string): Candidate | undefined {
  if (!line.startsWith(CANDIDATE)) return undefined;

  const fields = line.slice(CANDIDATE.length).split(' ');
  if (fields.length < 8 || fields[6] !== 'typ') return undefined;

  return {
    fields,
    transport: fields[2].toLowerCase(),
    address: fields[ADDRESS],
    port: fields[5],
    type: fields[7],
  };
}

function isPrivateV4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !(part >= 0 && part <= 255))) return false;

  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127) // CGNAT
  );
}

function isPrivateAddress(address: string): boolean {
  const a = address.toLowerCase();
  if (a.endsWith('.local')) return true; // mDNS
  if (!a.includes(':')) return isPrivateV4(a);
  if (a === '::' || a === '::1') return true;
  if (a.startsWith('::ffff:')) return isPrivateV4(a.slice('::ffff:'.length));

  const high = parseInt(a.split(':')[0] || '0', 16);
  return (high & 0xfe00) === 0xfc00 || (high & 0xffc0) === 0xfe80; // fc00::/7, fe80::/10
}

// ICE uses the related address for diagnostics only, and it exposes the peer's pre-NAT address.
function scrubRelated(fields: string[]): void {
  for (let i = 8; i + 1 < fields.length; i += 2) {
    if (fields[i] === 'raddr') fields[i + 1] = '0.0.0.0';
    else if (fields[i] === 'rport') fields[i + 1] = '0';
  }
}
