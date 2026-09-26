import { BlockList, isIP } from 'node:net';
import type { GatewayMiddleware, JoinContext } from '../types';

const CANDIDATE_PREFIX = 'a=candidate:';
// a=candidate:<foundation> <component> <transport> <priority> <address> <port> typ <type> [...extensions]
const [TRANSPORT, ADDRESS, PORT, TYPE] = [2, 4, 5, 7];

// Port 0 matches what libwebrtc writes when it hides a related address; RFC 8839 §5.1 asks for 9.
const MASKED_PORT = 0;

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
  '224.0.0.0/4', // multicast
  '240.0.0.0/4', // reserved and broadcast
  '::/128',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
  'fec0::/10', // deprecated site-local
  'ff00::/8', // multicast
]) {
  const [address, prefix] = subnet.split('/');
  PRIVATE.addSubnet(address, Number(prefix), address.includes(':') ? 'ipv6' : 'ipv4');
}

export interface CandidateAddress {
  ip: string;
  port: number;
}

export interface RewriteCandidateOptions {
  /**
   * The address advertised in place of every routable upstream candidate; a field left out keeps
   * the candidate's own value. A function receives the addresses of the answer's candidates. Omit
   * it to keep the routable candidates at their own address.
   */
  mapAddress?:
    | Partial<CandidateAddress>
    | ((addresses: CandidateAddress[], c: JoinContext) => Partial<CandidateAddress>);
  /**
   * What to send when no candidate survives. Defaults to `'original'`, which returns the answer
   * untouched, trading the address leak for a connection that can still complete.
   */
  fallback?: 'drop' | 'original';
  /**
   * Masks the related address, which exposes the upstream's own address. Defaults to `true`
   * (`0.0.0.0` or `::`, port 0); an object masks only the fields it gives.
   */
  maskRelatedAddress?: boolean | Partial<CandidateAddress>;
}

// Strips the client's candidates from the offer and keeps only the answer's candidates a remote
// client can reach: candidates without a global IP address are dropped, host candidates are
// dropped once a NAT-traversing candidate exists, and the survivors are readdressed to `mapAddress`.
export function rewriteCandidates(
  options: RewriteCandidateOptions = {},
): GatewayMiddleware<JoinContext> {
  const { mapAddress, fallback = 'original', maskRelatedAddress = true } = options;

  return async (c, next) => {
    const response = await next(
      new Request(c.req, { method: 'POST', body: stripCandidates(c.offer) }),
    );
    // Error and bodiless responses carry no session description.
    if (!response.ok || !response.body) return response;

    const answer = await response.text();
    const lines = answer.split(/\r?\n/u);
    const candidates = lines.flatMap((line, index) => {
      const fields = parseCandidate(line);
      return fields ? [{ index, fields }] : [];
    });
    const advertise =
      typeof mapAddress === 'function'
        ? mapAddress(
            candidates.map(({ fields }) => ({ ip: fields[ADDRESS], port: Number(fields[PORT]) })),
            c,
          )
        : mapAddress;

    const routable = candidates.filter(({ fields }) => !isPrivateAddress(fields[ADDRESS]));
    const hasNonHost = routable.some(({ fields }) => fields[TYPE] !== 'host');
    const kept = new Map<number, string>();
    const seen = new Set<string>();
    for (const { index, fields } of routable) {
      if (hasNonHost && fields[TYPE] === 'host') continue;

      const rewritten = fields.slice();
      if (advertise) {
        if (advertise.ip !== undefined) rewritten[ADDRESS] = advertise.ip;
        if (advertise.port !== undefined) rewritten[PORT] = String(advertise.port);
      }
      maskRelated(rewritten, maskRelatedAddress);

      // Per-interface candidates share one transport address, and readdressing adds more.
      const key = [
        rewritten[TRANSPORT].toLowerCase(),
        rewritten[ADDRESS],
        rewritten[PORT],
        rewritten[TYPE],
      ].join(' ');
      if (seen.has(key)) continue;
      seen.add(key);
      kept.set(index, CANDIDATE_PREFIX + rewritten.join(' '));
    }
    if (kept.size === 0 && fallback === 'original') return new Response(answer, response);

    const out = lines.flatMap(
      (line, index) => kept.get(index) ?? (line.startsWith(CANDIDATE_PREFIX) ? [] : line),
    );
    return new Response(out.join('\r\n'), response);
  };
}

function stripCandidates(sdp: string): string {
  return sdp
    .split(/\r?\n/u)
    .filter((line) => !line.startsWith(CANDIDATE_PREFIX))
    .join('\r\n');
}

function parseCandidate(line: string): string[] | undefined {
  if (!line.startsWith(CANDIDATE_PREFIX)) return undefined;
  const fields = line.slice(CANDIDATE_PREFIX.length).split(' ');
  return fields.length >= 8 && fields[6] === 'typ' ? fields : undefined;
}

// Only a global IP literal survives: a name, such as an mDNS one, cannot be checked.
function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  return family === 0 || PRIVATE.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

// ICE uses the related address for diagnostics only, and it exposes the peer's own address.
function maskRelated(fields: string[], mask: boolean | Partial<CandidateAddress>): void {
  if (!mask) return;
  const { ip, port } =
    mask === true
      ? { ip: isIP(fields[ADDRESS]) === 4 ? '0.0.0.0' : '::', port: MASKED_PORT }
      : mask;
  for (let i = 8; i + 1 < fields.length; i += 2) {
    if (fields[i] === 'raddr' && ip !== undefined) fields[i + 1] = ip;
    else if (fields[i] === 'rport' && port !== undefined) fields[i + 1] = String(port);
  }
}
