import { describe, expect, it } from 'vite-plus/test';
import { rewriteAnswerCandidates, stripOfferCandidates } from './sdpCandidate';

// Addresses are RFC 5737 / RFC 3849 documentation ranges and the identity blob is a stub.
const ADVERTISE = '203.0.113.10';
const IDENTITY = 'eyJpZHAiOnsiZG9tYWluIjoiYXV0aC5leGFtcGxlIn19';

const HOSTS = [
  'a=candidate:2008454536 1 udp 2121998079 172.29.112.1 51594 typ host generation 0 network-id 1',
  'a=candidate:3386594906 1 udp 2121932543 192.168.0.11 51595 typ host generation 0 network-id 2',
  'a=candidate:2850521474 1 udp 2122262783 2001:db8:142:be52:3fc0:6fa7:f85a:5a07 51596 typ host generation 0 network-id 3',
  'a=candidate:2821663040 1 udp 2122197247 2001:db8:142:be52:c37:f146:fbed:59c 51597 typ host generation 0 network-id 4',
];

// One reflexive 5-tuple observed through six local interfaces, as the upstream server reports it.
const REFLEXIVE = [
  `a=candidate:3387171477 1 udp 1685790463 ${ADVERTISE} 49132 typ srflx raddr 172.29.112.1 rport 19132 generation 0 network-id 1`,
  `a=candidate:3387171477 1 udp 1685724927 ${ADVERTISE} 49132 typ srflx raddr 192.168.0.11 rport 19132 generation 0 network-id 2`,
  `a=candidate:3387171477 1 udp 1686052607 ${ADVERTISE} 49132 typ srflx raddr 2001:db8:142:be52:3fc0:6fa7:f85a:5a07 rport 19132 generation 0 network-id 3`,
  `a=candidate:3387171477 1 udp 1685987071 ${ADVERTISE} 49132 typ srflx raddr 2001:db8:142:be52:c37:f146:fbed:59c rport 19132 generation 0 network-id 4`,
  `a=candidate:3387171477 1 udp 1685921535 ${ADVERTISE} 49132 typ srflx raddr 2001:db8:142:be52:e839:f32d:22d8:fa47 rport 19132 generation 0 network-id 5`,
  `a=candidate:3387171477 1 udp 1685855999 ${ADVERTISE} 49132 typ srflx raddr 2001:db8:142:be52:f504:acd3:1f8a:6394 rport 19132 generation 0 network-id 6`,
];

describe('rewriteAnswerCandidates', () => {
  it('collapses the reflexive candidates and blanks the related address', () => {
    const result = candidatesOf(rewriteAnswerCandidates(sdp(...REFLEXIVE), ADVERTISE));

    expect(result).toEqual([
      `a=candidate:3387171477 1 udp 1685790463 ${ADVERTISE} 49132 typ srflx raddr 0.0.0.0 rport 0 generation 0 network-id 1`,
    ]);
  });

  it('keeps the rest of the session description intact', () => {
    const answer = sdp(...REFLEXIVE);
    const result = rewriteAnswerCandidates(answer, ADVERTISE);

    expect(result.split('\r\n').filter((line) => !line.startsWith('a=candidate:'))).toEqual(
      answer.split('\r\n').filter((line) => !line.startsWith('a=candidate:')),
    );
    expect(result).toContain(`a=identity:${IDENTITY}`);
  });

  it('leaves the candidate address alone when nothing is advertised', () => {
    expect(candidatesOf(rewriteAnswerCandidates(sdp(...REFLEXIVE), ''))).toEqual([
      `a=candidate:3387171477 1 udp 1685790463 ${ADVERTISE} 49132 typ srflx raddr 0.0.0.0 rport 0 generation 0 network-id 1`,
    ]);
  });

  it('drops private host candidates and never readdresses the routable ones', () => {
    expect(candidatesOf(rewriteAnswerCandidates(sdp(...HOSTS), ADVERTISE))).toEqual([
      HOSTS[2],
      HOSTS[3],
    ]);
  });

  it('drops host candidates once a NAT-traversing candidate exists', () => {
    const result = candidatesOf(rewriteAnswerCandidates(sdp(...HOSTS, ...REFLEXIVE), ADVERTISE));

    expect(result).toHaveLength(1);
    expect(result[0]).toContain('typ srflx');
  });

  it('drops candidate lines it cannot parse', () => {
    const malformed = 'a=candidate:99 1 udp 1685790463 198.51.100.7 49132';
    const result = rewriteAnswerCandidates(sdp(malformed, ...REFLEXIVE), ADVERTISE);

    expect(result).not.toContain('198.51.100.7');
    expect(candidatesOf(result)).toHaveLength(1);
  });

  it('returns the original description when no candidate survives', () => {
    const answer = sdp(HOSTS[0], HOSTS[1]);

    expect(rewriteAnswerCandidates(answer, ADVERTISE)).toBe(answer);
    expect(candidatesOf(rewriteAnswerCandidates(answer, ADVERTISE, false))).toEqual([]);
  });

  it('returns descriptions without candidates untouched', () => {
    const answer = 'v=0\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel';

    expect(rewriteAnswerCandidates(answer, ADVERTISE)).toBe(answer);
  });

  it.each([
    [ADVERTISE, true],
    ['2001:db8:142:be52:3fc0:6fa7:f85a:5a07', true],
    ['0.0.0.0', false],
    ['10.0.0.1', false],
    ['127.0.0.1', false],
    ['100.64.0.1', false],
    ['169.254.1.1', false],
    ['172.29.112.1', false],
    ['192.168.0.11', false],
    ['::', false],
    ['::1', false],
    ['::ffff:192.168.0.11', false],
    ['fc00::1', false],
    ['fe80::1', false],
    ['9dc0f2a1-6f7c-4a2e-9f0e-2f3c1d5b7a84.local', false],
  ])('treats %s as routable: %s', (address, routable) => {
    const candidate = `a=candidate:1 1 udp 2122260223 ${address} 51594 typ host generation 0`;

    expect(candidatesOf(rewriteAnswerCandidates(sdp(candidate), '', false))).toEqual(
      routable ? [candidate] : [],
    );
  });
});

describe('stripOfferCandidates', () => {
  it('removes every candidate and normalizes the line endings', () => {
    const offer = sdp(...HOSTS).replaceAll('\r\n', '\n');
    const result = stripOfferCandidates(offer);

    expect(candidatesOf(result)).toEqual([]);
    expect(result).toBe(sdp());
  });
});

function sdp(...candidates: string[]): string {
  return [
    'v=0',
    'o=- 8670746109278176197 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=extmap-allow-mixed',
    'a=msid-semantic: WMS',
    `a=identity:${IDENTITY}`,
    'm=application 49132 UDP/DTLS/SCTP webrtc-datachannel',
    `c=IN IP4 ${ADVERTISE}`,
    ...candidates,
    'a=ice-ufrag:E5gz',
    'a=ice-pwd:AAAABBBBCCCCDDDDEEEEFFFF',
    `a=fingerprint:sha-256 ${Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0').toUpperCase()).join(':')}`,
    'a=setup:active',
    'a=mid:0',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
  ].join('\r\n');
}

function candidatesOf(sdp: string): string[] {
  return sdp.split('\r\n').filter((line) => line.startsWith('a=candidate:'));
}
