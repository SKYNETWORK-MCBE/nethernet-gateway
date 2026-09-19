import { BlockList, isIP } from 'node:net';

const CANDIDATE_PREFIX = 'a=candidate:';
// a=candidate:<foundation> <component> <transport> <priority> <address> <port> typ <type> [...extensions]
const ADDRESS = 4;

// The ranges a remote client cannot reach, matched by node:net rather than by hand.
const PRIVATE = new BlockList();
for (const subnet of [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10', // CGNAT
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '::/128',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
]) {
  const [address, prefix] = subnet.split('/');
  PRIVATE.addSubnet(address, Number(prefix), address.includes(':') ? 'ipv6' : 'ipv4');
}

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
  const routable = candidates.filter(([, candidate]) => !isPrivateAddress(candidate.address));
  const hasNonHost = routable.some(([, candidate]) => candidate.type !== 'host');

  const kept = new Map<number, string>();
  const seen = new Set<string>();
  for (const [index, candidate] of routable) {
    if (hasNonHost && candidate.type === 'host') continue;

    const fields = candidate.fields.slice();
    if (advertise) fields[ADDRESS] = advertise;
    scrubRelated(fields);

    // Readdressing collapses the per-interface candidates into duplicates of one transport address.
    const key = [candidate.transport, fields[ADDRESS], candidate.port, candidate.type].join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    kept.set(index, CANDIDATE_PREFIX + fields.join(' '));
  }
  if (kept.size === 0 && failOpen) return sdp;

  const out: string[] = [];
  lines.forEach((line, index) => {
    const rewritten = kept.get(index);
    if (rewritten !== undefined) out.push(rewritten);
    else if (!line.startsWith(CANDIDATE_PREFIX)) out.push(line);
  });
  return out.join('\r\n');
}

// Removes every candidate from an offer so the upstream server never sees the client's addresses.
export function stripOfferCandidates(sdp: string): string {
  return sdp
    .split(/\r?\n/u)
    .filter((line) => !line.startsWith(CANDIDATE_PREFIX))
    .join('\r\n');
}

function parseCandidate(line: string): Candidate | undefined {
  if (!line.startsWith(CANDIDATE_PREFIX)) return undefined;

  const fields = line.slice(CANDIDATE_PREFIX.length).split(' ');
  if (fields.length < 8 || fields[6] !== 'typ') return undefined;

  return {
    fields,
    transport: fields[2].toLowerCase(),
    address: fields[ADDRESS],
    port: fields[5],
    type: fields[7],
  };
}

function isPrivateAddress(address: string): boolean {
  if (address.toLowerCase().endsWith('.local')) return true; // mDNS

  const family = isIP(address);
  return family !== 0 && PRIVATE.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

// ICE uses the related address for diagnostics only, and it exposes the peer's pre-NAT address.
function scrubRelated(fields: string[]): void {
  for (let i = 8; i + 1 < fields.length; i += 2) {
    if (fields[i] === 'raddr') fields[i + 1] = '0.0.0.0';
    else if (fields[i] === 'rport') fields[i + 1] = '0';
  }
}
