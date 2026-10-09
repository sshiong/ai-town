/** Management credentials stay in the server environment, never in public configuration. */
export function assertFederationAdmin(adminToken: string) {
  const expected = process.env.FEDERATION_ADMIN_TOKEN;
  if (!expected || !adminToken || adminToken.length !== expected.length) {
    throw new Error('FEDERATION_ADMIN_UNAUTHORIZED');
  }
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ adminToken.charCodeAt(i);
  if (difference !== 0) throw new Error('FEDERATION_ADMIN_UNAUTHORIZED');
}
