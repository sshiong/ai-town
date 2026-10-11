type Address = { family: 4 | 6; value: bigint; text: string };

/** Canonical IP parsing shared by destination policy and trusted source metadata. */
export function parseAddress(input: string): Address | undefined {
  const text = input.toLowerCase().replace(/^\[|\]$/g, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(text)) {
    const parts = text.split('.');
    if (parts.some(part => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) return;
    return { family: 4, value: parts.reduce((n, part) => (n << BigInt(8)) + BigInt(part), BigInt(0)), text: parts.join('.') };
  }
  if (!text.includes(':') || text.includes('%')) return;
  let expanded = text;
  const tail = expanded.slice(expanded.lastIndexOf(':') + 1);
  if (tail.includes('.')) {
    const ipv4 = parseAddress(tail);
    if (!ipv4 || ipv4.family !== 4) return;
    expanded = expanded.slice(0, expanded.lastIndexOf(':') + 1) + `${(ipv4.value >> BigInt(16)).toString(16)}:${(ipv4.value & BigInt(65535)).toString(16)}`;
  }
  if (expanded.split('::').length > 2) return;
  const halves = expanded.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 && missing !== 0 || halves.length === 2 && missing < 1) return;
  const words = [...left, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...right];
  if (words.some(word => !/^[0-9a-f]{1,4}$/.test(word))) return;
  const value = words.reduce((n, word) => (n << BigInt(16)) + BigInt(`0x${word}`), BigInt(0));
  if (value >> BigInt(32) === BigInt(65535)) return parseAddress([BigInt(24), BigInt(16), BigInt(8), BigInt(0)].map(shift => Number((value >> shift) & BigInt(255))).join('.'));
  return { family: 6, value, text: words.map(word => Number.parseInt(word, 16).toString(16)).join(':') };
}

function inRange(address: Address, cidr: string) {
  const [host, length] = cidr.split('/');
  const base = parseAddress(host), bits = address.family === 4 ? 32 : 128;
  if (!base || base.family !== address.family || !/^\d+$/.test(length ?? '')) return false;
  const prefix = Number(length);
  if (prefix > bits) return false;
  return address.value >> BigInt(bits - prefix) === base.value >> BigInt(bits - prefix);
}
const PRIVATE = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', 'fc00::/7'];
const FORBIDDEN_V4 = ['0.0.0.0/8', '127.0.0.0/8', '169.254.0.0/16', '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/3'];
const METADATA = ['100.100.100.200/32', '168.63.129.16/32', 'fd00:ec2::254/128', 'fd20:ce::254/128'];

export function addressPolicy(input: string): 'public' | 'private' | 'forbidden' {
  const address = parseAddress(input);
  if (!address) return 'forbidden';
  if (METADATA.some(cidr => inRange(address, cidr))) return 'forbidden';
  if (PRIVATE.some(cidr => inRange(address, cidr))) return 'private';
  if (address.family === 4) return FORBIDDEN_V4.some(cidr => inRange(address, cidr)) ? 'forbidden' : 'public';
  // Global unicast only. Reject local/link-local/multicast, translation and
  // transition mechanisms whose embedded IPv4 destination can bypass policy.
  // IANA protocol-assignment and documentation blocks are not town endpoints.
  return inRange(address, '2000::/3') && !['2001::/23', '2001:db8::/32', '2002::/16', '3fff::/20'].some(cidr => inRange(address, cidr)) ? 'public' : 'forbidden';
}

export function privateNetworkAllowlist(input = ''): string[] {
  if (input.length > 4096) throw new Error('INVALID_PRIVATE_NETWORK_ALLOWLIST');
  if (!input.trim()) return [];
  const ranges = input.split(',').map(value => value.trim());
  if (ranges.length > 64 || ranges.some(cidr => {
    const [host, length, extra] = cidr.split('/'), base = parseAddress(host);
    return extra !== undefined || !base || !/^\d+$/.test(length ?? '') || Number(length) > (base.family === 4 ? 32 : 128) ||
      !PRIVATE.some(parent => inRange(base, parent) && Number(length) >= Number(parent.split('/')[1]));
  })) throw new Error('INVALID_PRIVATE_NETWORK_ALLOWLIST');
  return ranges;
}

export function assertDestinationAddresses(addresses: string[], allowlist: string[]) {
  if (!addresses.length || addresses.length > 64) throw new Error('DNS_RESOLUTION_FAILED');
  for (const input of addresses) {
    const address = parseAddress(input), policy = addressPolicy(input);
    if (!address || policy === 'forbidden') throw new Error('ENDPOINT_NOT_ALLOWED');
    if (policy === 'private' && !allowlist.some(cidr => inRange(address, cidr))) throw new Error('PRIVATE_ENDPOINT_NOT_AUTHORIZED');
  }
}

export function sourceNetworkKeys(input: string | null): string[] {
  const address = input ? parseAddress(input) : undefined;
  if (!address) return ['source:unknown'];
  const prefix = address.family === 4 ? 24 : 64;
  const bits = address.family === 4 ? 32 : 128;
  return [`ip:${address.family}:${address.value.toString(16)}`, `prefix:${address.family}:${(address.value >> BigInt(bits - prefix)).toString(16)}/${prefix}`];
}
