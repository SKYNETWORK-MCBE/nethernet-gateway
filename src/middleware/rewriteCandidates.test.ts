import { afterEach, describe, expect, it } from 'vite-plus/test';
import { NetherNetGateway } from '../gateway';
import { createTestServers, untrustedOffer } from '../test-helpers';
import type { JoinContext } from '../types';
import {
  rewriteCandidates,
  type CandidateAddress,
  type RewriteCandidateOptions,
} from './rewriteCandidates';

// Addresses are RFC 5737 / RFC 3849 documentation ranges and the identity blob is a stub.
const UPSTREAM = '198.51.100.20';
const ADVERTISE: CandidateAddress = { ip: '203.0.113.10', port: 19132 };
const ADVERTISE_V6: CandidateAddress = { ip: '2001:db8:ffff::10', port: 19132 };
const IDENTITY = 'eyJpZHAiOnsiZG9tYWluIjoiYXV0aC5leGFtcGxlIn19';

const HOSTS = [
  'a=candidate:2008454536 1 udp 2121998079 172.29.112.1 51594 typ host generation 0 network-id 1',
  'a=candidate:3386594906 1 udp 2121932543 192.168.0.11 51595 typ host generation 0 network-id 2',
  'a=candidate:2850521474 1 udp 2122262783 2001:db8:142:be52:3fc0:6fa7:f85a:5a07 51596 typ host generation 0 network-id 3',
  'a=candidate:2821663040 1 udp 2122197247 2001:db8:142:be52:c37:f146:fbed:59c 51597 typ host generation 0 network-id 4',
];

// One reflexive 5-tuple observed through six local interfaces, as the upstream server reports it.
const REFLEXIVE = [
  `a=candidate:3387171477 1 udp 1685790463 ${UPSTREAM} 49132 typ srflx raddr 172.29.112.1 rport 19132 generation 0 network-id 1`,
  `a=candidate:3387171477 1 udp 1685724927 ${UPSTREAM} 49132 typ srflx raddr 192.168.0.11 rport 19132 generation 0 network-id 2`,
  `a=candidate:3387171477 1 udp 1686052607 ${UPSTREAM} 49132 typ srflx raddr 2001:db8:142:be52:3fc0:6fa7:f85a:5a07 rport 19132 generation 0 network-id 3`,
  `a=candidate:3387171477 1 udp 1685987071 ${UPSTREAM} 49132 typ srflx raddr 2001:db8:142:be52:c37:f146:fbed:59c rport 19132 generation 0 network-id 4`,
  `a=candidate:3387171477 1 udp 1685921535 ${UPSTREAM} 49132 typ srflx raddr 2001:db8:142:be52:e839:f32d:22d8:fa47 rport 19132 generation 0 network-id 5`,
  `a=candidate:3387171477 1 udp 1685855999 ${UPSTREAM} 49132 typ srflx raddr 2001:db8:142:be52:f504:acd3:1f8a:6394 rport 19132 generation 0 network-id 6`,
];

const { serve, closeAll } = createTestServers();

afterEach(closeAll);

describe('rewriteCandidates', () => {
  it('strips the client candidates from the offer sent upstream', async () => {
    const { sent } = await run({ mapAddress: ADVERTISE }, sdp(), {
      offer: sdp(...HOSTS).replaceAll('\r\n', '\n'),
    });

    expect(sent).toBe(sdp());
  });

  it('collapses the reflexive candidates and masks their related address by default', async () => {
    const { text } = await run({ mapAddress: ADVERTISE }, sdp(...REFLEXIVE));

    expect(text).toBe(
      sdp(
        `a=candidate:3387171477 1 udp 1685790463 ${ADVERTISE.ip} ${ADVERTISE.port} typ srflx raddr 0.0.0.0 rport 0 generation 0 network-id 1`,
      ),
    );
  });

  it('rewrites answers with LF line endings', async () => {
    const answer = sdp(...HOSTS, ...REFLEXIVE).replaceAll('\r\n', '\n');
    const { text } = await run({ mapAddress: ADVERTISE }, answer);

    expect(candidatesOf(text)).toEqual([
      expect.stringContaining(`${ADVERTISE.ip} ${ADVERTISE.port} typ srflx`),
    ]);
  });

  it('keeps the rest of the session description intact', async () => {
    const answer = sdp(...REFLEXIVE);
    const { text } = await run({ mapAddress: ADVERTISE }, answer);

    expect(withoutCandidates(text)).toEqual(withoutCandidates(answer));
  });

  it('keeps the related address unless asked to mask it', async () => {
    const { text } = await run(
      { mapAddress: ADVERTISE, maskRelatedAddress: false },
      sdp(REFLEXIVE[0]),
    );

    expect(candidatesOf(text)[0]).toContain('raddr 172.29.112.1 rport 19132');
  });

  it.each([
    [ADVERTISE, 'raddr 0.0.0.0 rport 0'],
    [ADVERTISE_V6, 'raddr :: rport 0'],
  ])('masks the related address in the family of %o', async (mapAddress, related) => {
    // Both reflexive families of the upstream are masked by the advertised family.
    const { text } = await run(
      { mapAddress, maskRelatedAddress: true },
      sdp(REFLEXIVE[0], REFLEXIVE[2].replaceAll(UPSTREAM, '2001:db8:1::20')),
    );

    for (const candidate of candidatesOf(text)) expect(candidate).toContain(related);
  });

  it.each([
    [{ ip: '192.0.2.99' }, 'raddr 192.0.2.99 rport 19132'],
    [{ port: 9 }, 'raddr 172.29.112.1 rport 9'],
    [{ port: 0 }, 'raddr 172.29.112.1 rport 0'],
    [{ ip: '192.0.2.99', port: 9 }, 'raddr 192.0.2.99 rport 9'],
  ])('masks only the related fields given in %o', async (maskRelatedAddress, related) => {
    const { text } = await run({ mapAddress: ADVERTISE, maskRelatedAddress }, sdp(REFLEXIVE[0]));

    expect(candidatesOf(text)[0]).toContain(related);
  });

  it('drops private host candidates and collapses the routable ones', async () => {
    const { text } = await run({ mapAddress: ADVERTISE }, sdp(...HOSTS));

    expect(candidatesOf(text)).toEqual([
      `a=candidate:2850521474 1 udp 2122262783 ${ADVERTISE.ip} ${ADVERTISE.port} typ host generation 0 network-id 3`,
    ]);
  });

  // A server on a public address gathers one host candidate and no reflexive candidate at all,
  // so this is the shape that would otherwise hand the client the upstream server's own address.
  it('readdresses a lone public host candidate', async () => {
    const { text } = await run(
      { mapAddress: ADVERTISE },
      sdp(`a=candidate:1 1 udp 2122260223 ${UPSTREAM} 19132 typ host generation 0`),
    );

    expect(candidatesOf(text)).toEqual([
      `a=candidate:1 1 udp 2122260223 ${ADVERTISE.ip} ${ADVERTISE.port} typ host generation 0`,
    ]);
  });

  it.each(['srflx', 'prflx', 'relay'])(
    'drops host candidates once a routable %s candidate exists',
    async (type) => {
      const traversing = `a=candidate:5 1 udp 41885439 ${UPSTREAM} 60000 typ ${type} raddr 172.29.112.1 rport 19132 generation 0`;
      const { text } = await run({ mapAddress: ADVERTISE }, sdp(...HOSTS, traversing));

      expect(candidatesOf(text)).toEqual([expect.stringContaining(`typ ${type}`)]);
    },
  );

  it('keeps host candidates when only private candidates traverse NAT', async () => {
    const privateReflexive = REFLEXIVE[0].replace(UPSTREAM, '192.168.0.11');
    const { text } = await run({ mapAddress: ADVERTISE }, sdp(HOSTS[2], privateReflexive));

    expect(candidatesOf(text)).toEqual([expect.stringContaining('typ host')]);
  });

  it.each([
    'a=candidate:99 1 udp 1685790463 198.51.100.7 49132',
    'a=candidate:99 1 udp 1685790463 198.51.100.7 49132 typ',
    'a=candidate:99 1 udp 1685790463 198.51.100.7 49132 type srflx',
  ])('drops a candidate line it cannot parse: %s', async (malformed) => {
    const { text } = await run({ mapAddress: ADVERTISE }, sdp(malformed, HOSTS[2]));

    expect(text).not.toContain('198.51.100.7');
    expect(candidatesOf(text)).toEqual([expect.stringContaining('typ host')]);
  });

  it.each([
    ['transport', { mapAddress: ADVERTISE }, REFLEXIVE[1].replace(' udp ', ' tcp '), 2],
    ['type', { mapAddress: ADVERTISE }, REFLEXIVE[1].replace('typ srflx', 'typ relay'), 2],
    ['transport case', { mapAddress: ADVERTISE }, REFLEXIVE[1].replace(' udp ', ' UDP '), 1],
    ['port', {}, REFLEXIVE[1].replace(' 49132 ', ' 49133 '), 2],
  ])('dedups candidates by %s', async (_, options: RewriteCandidateOptions, other, length) => {
    const { text } = await run(options, sdp(REFLEXIVE[0], other));

    expect(candidatesOf(text)).toHaveLength(length);
  });

  it('returns the original answer when no candidate survives', async () => {
    const answer = sdp(HOSTS[0], HOSTS[1]);
    const { response, text } = await run({ mapAddress: ADVERTISE }, answer, {
      init: { status: 201, headers: { 'x-upstream': '1' } },
    });

    expect(text).toBe(answer);
    expect(response.status).toBe(201);
    expect(response.headers.get('x-upstream')).toBe('1');
    expect((await run({ mapAddress: ADVERTISE, fallback: 'original' }, answer)).text).toBe(answer);
  });

  it('drops every candidate when no candidate survives with the drop fallback', async () => {
    const answer = sdp(HOSTS[0], HOSTS[1]);
    const { text } = await run({ mapAddress: ADVERTISE, fallback: 'drop' }, answer);

    expect(text).toBe(sdp());
  });

  it('returns answers without candidates untouched', async () => {
    const answer = 'v=0\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel';

    expect((await run({ mapAddress: ADVERTISE }, answer)).text).toBe(answer);
  });

  it.each([
    [UPSTREAM, true],
    ['2001:db8:142:be52:3fc0:6fa7:f85a:5a07', true],
    ['100.128.0.1', true],
    ['172.32.0.1', true],
    ['0.0.0.0', false],
    ['10.255.255.255', false],
    ['127.0.0.1', false],
    ['100.64.0.1', false],
    ['100.127.255.255', false],
    ['169.254.1.1', false],
    ['172.16.0.1', false],
    ['172.31.255.255', false],
    ['192.168.255.255', false],
    ['::', false],
    ['::1', false],
    ['::ffff:192.168.0.11', false],
    ['fc00::1', false],
    ['fd12:3456::1', false],
    ['fe80::1', false],
    ['febf::1', false],
    ['fec0::1', false],
    ['224.0.0.1', false],
    ['255.255.255.255', false],
    ['ff02::1', false],
    ['9dc0f2a1-6f7c-4a2e-9f0e-2f3c1d5b7a84.local', false],
    ['9DC0F2A1-6F7C-4A2E-9F0E-2F3C1D5B7A84.LOCAL', false],
    ['9dc0f2a1-6f7c-4a2e-9f0e-2f3c1d5b7a84.local.', false],
    ['localhost', false],
    ['upstream.example.com', false],
  ])('treats %s as routable: %s', async (address, routable) => {
    const candidate = `a=candidate:1 1 udp 2122260223 ${address} 51594 typ host generation 0`;
    const { text } = await run({ mapAddress: ADVERTISE, fallback: 'drop' }, sdp(candidate));

    expect(candidatesOf(text)).toHaveLength(routable ? 1 : 0);
  });

  it('asks mapAddress for the address to advertise', async () => {
    const calls: [CandidateAddress[], JoinContext][] = [];
    const c = context(sdp());
    const { text } = await run(
      {
        mapAddress: (addresses, ctx) => {
          calls.push([addresses, ctx]);
          return ADVERTISE_V6;
        },
      },
      sdp(HOSTS[0], REFLEXIVE[0]),
      { context: c },
    );

    expect(calls).toEqual([
      [
        [
          { ip: '172.29.112.1', port: 51594 },
          { ip: UPSTREAM, port: 49132 },
        ],
        c,
      ],
    ]);
    expect(candidatesOf(text)[0]).toContain(`${ADVERTISE_V6.ip} ${ADVERTISE_V6.port} typ srflx`);
  });

  it.each([
    [{ ip: ADVERTISE.ip }, `${ADVERTISE.ip} 49132 typ srflx`],
    [{ port: 40000 }, `${UPSTREAM} 40000 typ srflx`],
    [{}, `${UPSTREAM} 49132 typ srflx`],
    [() => ({ port: 40000 }), `${UPSTREAM} 40000 typ srflx`],
  ])('readdresses only the fields mapAddress gives: %o', async (mapAddress, address) => {
    const { text } = await run({ mapAddress }, sdp(REFLEXIVE[0]));

    expect(candidatesOf(text)).toEqual([expect.stringContaining(address)]);
  });

  it('keeps the upstream status and headers', async () => {
    const { response, text } = await run({ mapAddress: ADVERTISE }, sdp(...REFLEXIVE), {
      init: { status: 201, headers: { 'content-type': 'application/sdp', 'x-upstream': '1' } },
    });

    expect(candidatesOf(text)).toEqual([expect.stringContaining(ADVERTISE.ip)]);
    expect(response.status).toBe(201);
    expect(response.headers.get('content-type')).toBe('application/sdp');
    expect(response.headers.get('x-upstream')).toBe('1');
  });

  it('passes error responses through untouched', async () => {
    let called = false;
    const answer = sdp(...HOSTS);
    const { response, text } = await run(
      {
        mapAddress: () => {
          called = true;
          return ADVERTISE;
        },
        fallback: 'drop',
      },
      answer,
      { init: { status: 502 } },
    );

    expect(response.status).toBe(502);
    expect(text).toBe(answer);
    expect(called).toBe(false);
  });

  it('passes responses without a body through', async () => {
    const { response } = await run({ mapAddress: ADVERTISE }, null, { init: { status: 204 } });

    expect(response.status).toBe(204);
  });

  it('keeps the routable candidates at their own address without mapAddress', async () => {
    const { text } = await run({}, sdp(...HOSTS, ...REFLEXIVE));

    expect(candidatesOf(text)).toEqual([
      `a=candidate:3387171477 1 udp 1685790463 ${UPSTREAM} 49132 typ srflx raddr 0.0.0.0 rport 0 generation 0 network-id 1`,
    ]);
  });

  it('keeps every public host candidate without mapAddress', async () => {
    const { text } = await run({}, sdp(...HOSTS));

    expect(candidatesOf(text)).toEqual(HOSTS.slice(2));
  });

  it('applies the fallback without mapAddress when no candidate survives', async () => {
    const answer = sdp(HOSTS[0], HOSTS[1]);

    expect((await run({}, answer)).text).toBe(answer);
    expect((await run({ fallback: 'drop' }, answer)).text).toBe(sdp());
  });

  it('masks the related address in the family of each candidate without mapAddress', async () => {
    const v6 = REFLEXIVE[2].replaceAll(UPSTREAM, '2001:db8:1::20');
    const { text } = await run({}, sdp(REFLEXIVE[0], v6));

    expect(candidatesOf(text)).toEqual([
      expect.stringContaining(`${UPSTREAM} 49132 typ srflx raddr 0.0.0.0 rport 0 `),
      expect.stringContaining('2001:db8:1::20 49132 typ srflx raddr :: rport 0 '),
    ]);
  });

  it('rewrites both directions of a join through the gateway', async () => {
    let received: string | undefined;
    const upstream = await serve(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      received = Buffer.concat(chunks).toString();
      res.setHeader('content-type', 'application/sdp');
      res.end(sdp(...HOSTS, ...REFLEXIVE));
    });
    const gateway = new NetherNetGateway({ upstream });
    gateway.use('join', rewriteCandidates({ mapAddress: ADVERTISE }));
    const address = await serve(gateway.handleRequest.bind(gateway));
    const offer = untrustedOffer(['v=0', ...HOSTS].join('\r\n'));

    const response = await fetch(`${address}/v1/join/1`, { method: 'POST', body: offer });
    const answer = await response.text();

    expect(response.status).toBe(200);
    expect(received).toBe(
      offer
        .split('\r\n')
        .filter((line) => !HOSTS.includes(line))
        .join('\r\n'),
    );
    expect(candidatesOf(answer)).toEqual([
      `a=candidate:3387171477 1 udp 1685790463 ${ADVERTISE.ip} ${ADVERTISE.port} typ srflx raddr 0.0.0.0 rport 0 generation 0 network-id 1`,
    ]);
  });

  it.each([-1, 65536, 1.5, Number.NaN])('throws when maskRelatedAddress.port is %s', (port) => {
    expect(() => rewriteCandidates({ maskRelatedAddress: { port } })).toThrow(RangeError);
  });

  it('accepts maskRelatedAddress.port at both ends of the range', () => {
    expect(() => rewriteCandidates({ maskRelatedAddress: { port: 0 } })).not.toThrow();
    expect(() => rewriteCandidates({ maskRelatedAddress: { port: 65535 } })).not.toThrow();
  });
});

// Runs the middleware against a stubbed upstream answer and returns what each side saw.
async function run(
  options: RewriteCandidateOptions,
  answer: string | null,
  {
    offer = sdp(),
    init,
    context: c = context(offer),
  }: {
    offer?: string;
    init?: ResponseInit;
    context?: JoinContext;
  } = {},
) {
  let sent: string | undefined;
  const response = await rewriteCandidates(options)(c, async (req) => {
    sent = await req?.text();
    return new Response(answer, init);
  });
  return { sent, response, text: await response.text() };
}

function context(offer: string): JoinContext {
  const req = new Request('http://localhost/v1/join/1', { method: 'POST', body: offer });
  return {
    req,
    url: new URL(req.url),
    remoteAddress: '192.0.2.1',
    networkId: '1',
    offer,
    untrustedIdentity: { xuid: '0', playFabId: '0', gamertag: 'Player', claims: {} },
    identity: undefined,
  };
}

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
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    ...candidates,
    'a=ice-ufrag:E5gz',
    'a=ice-pwd:AAAABBBBCCCCDDDDEEEEFFFF',
    'a=fingerprint:sha-256 00:01:02:03',
    'a=setup:active',
    'a=mid:0',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
  ].join('\r\n');
}

function candidatesOf(sdp: string): string[] {
  return sdp.split('\r\n').filter((line) => line.startsWith('a=candidate:'));
}

function withoutCandidates(sdp: string): string[] {
  return sdp.split('\r\n').filter((line) => !line.startsWith('a=candidate:'));
}
