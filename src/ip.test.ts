import { describe, expect, it } from 'vite-plus/test';
import { isIP, SubnetList } from './ip';

describe('isIP', () => {
  it.each([
    ['192.0.2.1', 4],
    ['0.0.0.0', 4],
    ['255.255.255.255', 4],
    ['::', 6],
    ['::1', 6],
    ['2001:db8::1', 6],
    ['::ffff:192.0.2.1', 6],
    ['fe80::1%eth0', 6],
    ['01.2.3.4', 0],
    ['256.0.0.1', 0],
    ['1.2.3', 0],
    ['example.com', 0],
    ['', 0],
    ['::1]/x[', 0],
    ['fe80::1%', 0],
    ['1:2:3:4:5:6:7:8:9', 0],
  ])('classifies %s as %i', (address, family) => {
    expect(isIP(address)).toBe(family);
  });
});

describe('SubnetList', () => {
  const list = new SubnetList(['10.0.0.0/8', '172.16.0.0/12', 'fc00::/7', '0.0.0.0/8']);

  it.each([
    ['10.1.2.3', true],
    ['11.0.0.1', false],
    ['172.31.255.255', true],
    ['172.32.0.0', false],
    ['fd00::1', true],
    ['fe00::1', false],
    ['::ffff:10.0.0.1', true],
    ['::ffff:a00:1', true],
    ['::ffff:8.8.8.8', false],
    ['not an address', false],
  ])('matches %s: %s', (address, expected) => {
    expect(list.has(address)).toBe(expected);
  });

  it('rejects invalid subnets', () => {
    expect(() => new SubnetList(['10.0.0.0/33'])).toThrow(TypeError);
    expect(() => new SubnetList(['host/8'])).toThrow(TypeError);
  });
});
