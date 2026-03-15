import crypto from 'crypto';
export const uid    = () => crypto.randomUUID();
export const sha256 = s  => crypto.createHash('sha256').update(String(s)).digest('hex');
export const now    = () => new Date().toISOString();

export function cidrToIPs(cidr) {
  const [network, bits] = cidr.split('/');
  const prefix = parseInt(bits, 10);
  if (isNaN(prefix) || prefix < 8 || prefix > 31) return [];
  const parts = network.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => p < 0 || p > 255)) return [];
  const base  = (parts[0] << 24 | parts[1] << 16 | parts[2] << 8 | parts[3]) >>> 0;
  const mask  = (0xFFFFFFFF << (32 - prefix)) >>> 0;
  const net   = (base & mask) >>> 0;
  const bcast = (net | (~mask >>> 0)) >>> 0;
  const hosts = [];
  for (let i = net + 1; i < bcast; i++) {
    hosts.push([i >>> 24 & 0xFF, i >>> 16 & 0xFF, i >>> 8 & 0xFF, i & 0xFF].join('.'));
  }
  return hosts;
}
