// Runtime-agnostic replacements for node:net's isIP and BlockList.

export interface ParsedIP {
  family: 4 | 6;
  /** 4 or 16 bytes in network order. */
  bytes: Uint8Array;
  /** The IPv6 zone index, such as `eth0` in `fe80::1%eth0`. */
  zone?: string;
}

const IPV4_OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = new RegExp(`^${IPV4_OCTET}(?:\\.${IPV4_OCTET}){3}$`, 'u');

export function parseIP(address: string): ParsedIP | undefined {
  if (IPV4.test(address)) {
    return { family: 4, bytes: Uint8Array.from(address.split('.'), Number) };
  }

  const [host, zone, extra] = address.split('%');
  if (extra !== undefined || zone === '' || !host.includes(':') || !/^[\da-f:.]+$/iu.test(host)) {
    return undefined;
  }

  let canonical: string;
  try {
    // The WHATWG URL parser validates IPv6 and serializes it without an embedded IPv4 part.
    canonical = new URL(`http://[${host}]/`).hostname.slice(1, -1);
  } catch {
    return undefined;
  }

  const [left, right = ''] = canonical.split('::');
  const head = left ? left.split(':') : [];
  const tail = right ? right.split(':') : [];
  const groups = [...head, ...Array<string>(8 - head.length - tail.length).fill('0'), ...tail];
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    const value = Number.parseInt(group, 16);
    bytes[index * 2] = value >>> 8;
    bytes[index * 2 + 1] = value & 0xff;
  });
  return zone === undefined ? { family: 6, bytes } : { family: 6, bytes, zone };
}

export function isIP(address: string): 0 | 4 | 6 {
  return parseIP(address)?.family ?? 0;
}

/** Returns the IPv4 address an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) stands for. */
export function unmapIPv4(ip: ParsedIP): ParsedIP {
  if (ip.family !== 6) return ip;
  const { bytes } = ip;
  for (let index = 0; index < 10; index++) if (bytes[index] !== 0) return ip;
  if (bytes[10] !== 0xff || bytes[11] !== 0xff) return ip;
  return { family: 4, bytes: bytes.slice(12) };
}

export class SubnetList {
  private readonly subnets: Array<{ family: 4 | 6; bytes: Uint8Array; prefix: number }> = [];

  constructor(cidrs: readonly string[] = []) {
    for (const cidr of cidrs) this.add(cidr);
  }

  add(cidr: string): void {
    const [address, prefix] = cidr.split('/');
    const ip = parseIP(address);
    const bits = Number(prefix);
    if (!ip || !Number.isInteger(bits) || bits < 0 || bits > ip.bytes.length * 8) {
      throw new TypeError(`Invalid subnet: ${cidr}`);
    }
    this.subnets.push({ family: ip.family, bytes: ip.bytes, prefix: bits });
  }

  /** Like node:net's BlockList, an IPv4-mapped IPv6 address also matches IPv4 subnets. */
  has(address: string | ParsedIP): boolean {
    const parsed = typeof address === 'string' ? parseIP(address) : address;
    if (!parsed) return false;
    const candidates = [parsed, unmapIPv4(parsed)];
    return this.subnets.some((subnet) =>
      candidates.some((ip) => ip.family === subnet.family && matches(ip.bytes, subnet)),
    );
  }
}

function matches(bytes: Uint8Array, subnet: { bytes: Uint8Array; prefix: number }): boolean {
  let remaining = subnet.prefix;
  for (let index = 0; remaining > 0; index++, remaining -= 8) {
    const mask = remaining >= 8 ? 0xff : (0xff << (8 - remaining)) & 0xff;
    if ((bytes[index] & mask) !== (subnet.bytes[index] & mask)) return false;
  }
  return true;
}
