// Destructive fault injection only for two dedicated local Docker test deployments.
// Credentials and container names belong in an external 0600 configuration file.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '../convex/_generated/api.js';

const path = process.env.FEDERATION_TEST_CONFIG;
if (!path) throw new Error('Set FEDERATION_TEST_CONFIG to the private Docker test configuration');
const config = JSON.parse(fs.readFileSync(path, 'utf8'));
assert.equal(config.towns.length, 2);
const towns = config.towns.map(c => {
  assert.match(c.containerName, /^aitown-federation-[a-z0-9-]+$/);
  const url = new URL(c.url);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'Fault injection requires local backends');
  const inspect = JSON.parse(execFileSync('docker', ['inspect', c.containerName], { encoding: 'utf8' }))[0];
  const published = Object.values(inspect.NetworkSettings.Ports).flat().filter(Boolean);
  assert.ok(published.some(p => p.HostPort === url.port), 'Container must publish the configured API port');
  const client = new ConvexHttpClient(c.url);client.setAdminAuth(c.adminKey);
  return { ...c, client };
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const auth = t => ({ adminToken:t.adminToken });
const status = t => t.client.query(api.federation.admin.status,auth(t));
const residents = t => t.client.query(api.federation.runtime.listResidents,auth(t));
const world = async (t,worldId) => (await t.client.query(api.world.worldState,{worldId})).world;
async function waitFor(label, read, accept, timeout=90_000) {
  const until=Date.now()+timeout;
  let last;
  while(Date.now()<until){last=await read();if(accept(last))return last;await pause(1500);}
  throw new Error(`Timed out waiting for ${label}`);
}
async function backendReady(t){return waitFor('backend restart',async()=>{try{return await status(t);}catch{return null;}},s=>!!s,60_000);}
function docker(t,operation){execFileSync('docker',[operation,t.containerName],{stdio:'pipe'});}
const original = await Promise.all(towns.map(status));
for (const state of original) assert.ok(!state.visits.some(v=>!['COMPLETED','REJECTED'].includes(v.state)), 'End existing visits first');
const evidence=[];
async function readyPair(){
  for(let i=0;i<2;i++)await towns[i].client.action(api.federation.transport.probe,{...auth(towns[i]),peerTownId:original[1-i].identity.townId});
  for(let i=0;i<2;i++)await waitFor('mutual authenticated readiness',()=>status(towns[i]),s=>s.peers.some(p=>p.townId===original[1-i].identity.townId&&p.channelState==='TRANSPORT_READY'));
}
async function visit(){
  await readyPair();
  const [home,host]=towns, resident=(await residents(home)).find(r=>r.state==='HOME_ACTIVE');assert.ok(resident);
  const hostWorld=await host.client.query(api.world.defaultWorldStatus,{});
  const beforeHost=await world(host,hostWorld.worldId);
  const {visitId}=await home.client.mutation(api.federation.ledger.startVisit,{...auth(home),peerTownId:original[1].identity.townId,worldId:resident.worldId,homePlayerId:resident.playerId});
  const active=await waitFor('active visitor',()=>status(home),s=>s.visits.some(v=>v.visitId===visitId&&v.state==='ACTIVE'));
  await waitFor('Host body',()=>world(host,hostWorld.worldId),w=>w.players.some(p=>p.remoteVisitor?.visitId===visitId));
  const homeWorld=await world(home,resident.worldId);
  assert.ok(!homeWorld.players.some(p=>p.id===resident.playerId));
  assert.equal(homeWorld.agents.filter(a=>a.id===resident.agentId).length,1);
  assert.equal((await world(host,hostWorld.worldId)).agents.length,beforeHost.agents.length);
  return {home,host,resident,visitId,hostWorldId:hostWorld.worldId,leaseExpiry:active.visits.find(v=>v.visitId===visitId).leaseExpiry};
}
async function assertReturned(v){
  await waitFor('same resident returning',()=>residents(v.home),rs=>rs.some(r=>r.agentGlobalId===v.resident.agentGlobalId&&r.state==='HOME_ACTIVE'),180_000);
  assert.equal((await world(v.home,v.resident.worldId)).players.filter(p=>p.id===v.resident.playerId).length,1);
}
async function assertHostCleaned(v){
  await waitFor('expired Host presence removed',()=>world(v.host,v.hostWorldId),w=>!w.players.some(p=>p.remoteVisitor?.visitId===v.visitId));
  await waitFor('Host reservation released',()=>status(v.host),s=>s.visits.some(l=>l.visitId===v.visitId&&l.state==='COMPLETED')&&s.capacity.reserved===0);
}
try {
  for(let i=0;i<2;i++){
    const t=towns[i],s=original[i].settings;
    await t.client.mutation(api.federation.admin.configure,{...auth(t),enabled:true,allowIncomingPairRequests:s.allowIncomingPairRequests,maxVisitors:s.maxVisitors,maxVisitDurationMs:60_000,replyTimeoutMs:90_000});
  }
  const crashed=await visit();
  docker(crashed.host,'kill');
  console.log('Host forcibly killed after real visitor creation; Home body remains absent');
  await crashed.home.client.mutation(api.federation.ledger.returnVisit,{...auth(crashed.home),visitId:crashed.visitId});
  assert.ok(!(await world(crashed.home,crashed.resident.worldId)).players.some(p=>p.id===crashed.resident.playerId));
  // No cleanup ACK is possible while the actual Host process remains dead.
  // Continuously verify that Home cannot resume during the last issued lease.
  while(Date.now()<crashed.leaseExpiry){
    assert.ok(!(await world(crashed.home,crashed.resident.worldId)).players.some(p=>p.id===crashed.resident.playerId));
    await pause(1500);
  }
  await assertReturned(crashed);
  const returnedAt=Date.now();
  // The implementation's documented default safety margin is 60 seconds.
  assert.ok(returnedAt>=crashed.leaseExpiry+60_000,'Home resumed before the safety margin');
  docker(crashed.host,'start');await backendReady(crashed.host);await assertHostCleaned(crashed);
  assert.equal((await status(crashed.host)).identity.deploymentInstanceId,original[1].identity.deploymentInstanceId);
  evidence.push({scenario:'host-killed-after-creation',visitId:crashed.visitId,leaseExpiry:crashed.leaseExpiry,returnedAt,originalPlayerId:crashed.resident.playerId,originalAgentGlobalId:crashed.resident.agentGlobalId});
  console.log('Host crash passed: last lease plus safety margin, original identity returned, restart removed stale body and capacity');

  const restarted=await visit();
  docker(restarted.home,'kill');await pause(1500);docker(restarted.home,'start');
  const homeAfter=await backendReady(restarted.home);
  assert.equal(homeAfter.identity.deploymentInstanceId,original[0].identity.deploymentInstanceId);
  assert.equal(homeAfter.identity.deploymentEpoch,original[0].identity.deploymentEpoch);
  assert.ok(!(await world(restarted.home,restarted.resident.worldId)).players.some(p=>p.id===restarted.resident.playerId),'Home restart created a second body');
  const hostBodies=(await world(restarted.host,restarted.hostWorldId)).players.filter(p=>p.remoteVisitor?.visitId===restarted.visitId);
  assert.equal(hostBodies.length,1);
  await restarted.home.client.mutation(api.federation.ledger.returnVisit,{...auth(restarted.home),visitId:restarted.visitId});
  await assertReturned(restarted);await assertHostCleaned(restarted);
  evidence.push({scenario:'home-restarted-during-visit',visitId:restarted.visitId,originalPlayerId:restarted.resident.playerId,originalAgentGlobalId:restarted.resident.agentGlobalId});
  console.log('Home crash passed: persisted identity/ledger, no duplicate presence, authenticated cleanup and same resident resumed');
  if(process.env.FEDERATION_FAULT_REPORT)fs.writeFileSync(process.env.FEDERATION_FAULT_REPORT,JSON.stringify({verifiedAt:Date.now(),scenarios:evidence}),{mode:0o600});
} finally {
  for(const t of towns){docker(t,'start');await backendReady(t);}
  for(let i=0;i<2;i++){
    const t=towns[i],s=original[i].settings;
    for(const v of (await status(t)).visits.filter(v=>v.role==='home'&&!['COMPLETED','REJECTED'].includes(v.state)))await t.client.mutation(api.federation.ledger.returnVisit,{...auth(t),visitId:v.visitId});
    await t.client.mutation(api.federation.admin.configure,{...auth(t),enabled:s.enabled,allowIncomingPairRequests:s.allowIncomingPairRequests,maxVisitors:s.maxVisitors,maxVisitDurationMs:s.maxVisitDurationMs,replyTimeoutMs:s.replyTimeoutMs});
  }
}
