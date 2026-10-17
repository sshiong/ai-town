// Pure response decoding only: no socket listeners or network faults.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePartitionRefusal } from './federation-network-partition-gate.mjs';

test('exact protocol codes are preserved without arbitrary response data', () => {
  for (const code of ['VISIT_LEASE_EXPIRED', 'MESSAGE_EXPIRED', 'FEDERATION_REJECTED']) {
    const bytes = Buffer.from(JSON.stringify({ error: code, privateText: 'private-response-must-not-persist' }));
    const decoded = decodePartitionRefusal(bytes);
    assert.equal(decoded.reason, code); assert.equal(decoded.responseFormat, 'json-error-code');
    assert.equal(decoded.responseBytes, bytes.length);
    assert.ok(!JSON.stringify(decoded).includes('private-response'));
  }
});

test('wrapped/nested errors and arbitrary matching substrings never become lease evidence', () => {
  for (const error of ['[Request ID: private] Server Error\nUncaught Error: VISIT_LEASE_EXPIRED\n at private-path',
    'private-prefix VISIT_LEASE_EXPIRED', { message: 'VISIT_LEASE_EXPIRED', secret: 'private-value' }]) {
    const decoded = decodePartitionRefusal(Buffer.from(JSON.stringify({ error })));
    assert.equal(decoded.reason, 'UNEXPECTED_RESPONSE');
    assert.ok(!JSON.stringify(decoded).includes('private'));
  }
  assert.equal(decodePartitionRefusal(Buffer.from('private invalid response')).responseFormat, 'non-json');
});
