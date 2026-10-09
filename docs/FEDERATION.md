# Federation administration

The **Town admin** button opens the pixel-style control panel beside the existing Pixi town.
Federation does not replace the local simulation, its sprites, movement interpolation or
conversation controls.

## Deployment and access

Configure `VITE_CONVEX_URL` for the frontend's Convex deployment and restart Vite. Without a valid
URL the frontend displays setup instructions instead of a blank page. An interrupted server
connection displays a connection notice; query failures have a retry view.

Configure these secrets on the **backend**, never with a `VITE_` prefix:

- `FEDERATION_ADMIN_TOKEN`: a high-entropy administrator token of at least 24 characters.
- `FEDERATION_KEY_ENCRYPTION_KEY`: 32 random bytes encoded as standard base64, used to encrypt
  persistent federation credentials.
- Provider API keys referenced by model profiles, such as `OPENAI_API_KEY`.

Enter the administrator token in Town admin. It stays in memory unless “Remember in this browser
tab's session” is explicitly selected. Lock clears both in-memory access and the saved session
token. Remembering the token does not bypass server authorization.

## Pairing two towns

1. Initialize each town with its name, its own public HTTPS HTTP-actions endpoint and visitor
   capacity. The stable Town ID and verified public-key fingerprint are displayed independently of
   the URL.
2. Generate a pairing secret on the initiating town. Share it with the other administrator through a
   trusted channel. Use **Show generated secret** only when copying it securely.
3. Submit the other town's endpoint. On the receiving town, independently enter the shared secret
   and approve or reject the persisted request.
4. Continue the outgoing request after approval. `TRUSTED` means identity verification succeeded.
5. Run **Probe transport**. Visits are enabled only when both authenticated directions are verified
   and peer policy permits outgoing travel. One-way reachability is insufficient.

Changing an endpoint verifies the same identity at its new address and requires fresh transport
probes. Peer permissions can pause or revoke trust independently from admission settings.

This build uses `DIRECT_HTTPS`. HTTP is locked to `DISABLED` with reason
`HTTP_AUTH_LIBRARY_UNAVAILABLE`. Neither plaintext HTTP nor HTTP application-layer encryption is
presented as available. There is no WSS, NAT relay or automatic HTTPS-to-HTTP fallback.

## Visits and safe return

In **Travel & visitors**, register existing residents to create persistent runtime identities and
fixed model bindings. Select a resident at home and a trusted, transport-ready destination, then
request a visit. Admission, reservation, local suspension and host presence are asynchronous; use
the visit ledger to see confirmed state.

The destination's capacity counts reserved places until cleanup is confirmed. Map visitors and
reservations are distinct. The destination executes movement and conversations; the home deployment
supplies its resident's model and private memory. The map labels remote visitors with their home
town. Residents away remain visible in the local sidebar even while their local map presence is
suspended.

**End / return safely** requests cleanup. A disconnected home must wait for confirmed host cleanup
or lease expiry plus the safety margin before restoring its local presence. It does not create an
immediate local duplicate. Expired model turns are rejected before a chat message is committed.
Delivery diagnostics show the real persistent Inbox, Outbox and stream cursors; **Retry delivery /
reconcile** runs the backend worker.

## Models and memory

Add Chat and Embedding profiles independently. Enter only the server environment-variable name for a
credential. The page reports whether that credential is available and offers a real provider
connection test, which can consume provider credits.

The first saved Chat profile becomes `main`. Changing `main` affects new residents. Existing
residents retain their stored binding unless an administrator changes that resident with an audit
reason. Model failure does not authorize sending private memory to another provider.

Before building a new Embedding index, use **Review switch** to inspect source and target
fingerprints and affected memories. Equal dimensions do not prove compatibility. Build, validate and
activate are separate operations; activation requires completed validation. The previous index
remains available for rollback. Building does not delete canonical memory text or relationships.

## Export, import and recovery

**Data & backups** offers a full-town snapshot or a selected resident snapshot as JSON. Packages
exclude model secrets, pairing credentials, identity private keys and active travel authorizations.
Backups contain private resident text and should be stored securely. **Encrypted identity recovery**
exports a separate passphrase-protected, signed identity package (PBKDF2-SHA256 and AES-256-GCM).
Use a passphrase of at least 12 characters and preserve it separately. Recovery requires a stopped
source and an empty destination; it keeps the signing identity, rewraps its private key under the
destination server key, creates a new deployment instance, advances the deployment epoch and leaves
federation disabled. Identity packages do not contain town memories; restore the ordinary archive
after identity recovery. Export and recovery operations have an administrator audit trail.

Small atomic snapshots retain their **5 MiB / 500 record** limit. **Large town archives** use signed
manifests and separate JSON chunks, a durable maintenance lock and resumable checkpoints. Each chunk
is at most 900,000 bytes, with a 1 GiB archive and 20,000 chunk cap. Individual documents larger than
the chunk limit are rejected. Derived vectors are omitted and rebuilt from canonical memories.

Disable federation and explicitly pause the simulation before starting a large archive. Download
the manifest and every chunk, either into a selected folder when the browser supports it or as
individual files. Import uploads and validates every chunk, schema and cross-document reference
before applying changes. Restore/migrate require matching identity and source shutdown; cloning
requires an empty destination and creates a new identity. Resident merges retain the small-package
workflow.

Applying a large import runs in maintenance mode. A private, durable target snapshot supports
rollback across transaction batches; it is never exposed through the public download API. A failure
keeps the lock and checkpoint. Resume the task or cancel it and drive rollback to completion before
resuming the simulation. Target document IDs can change after rollback and references are remapped.
Do not remove the job, stored chunks or journal while recovery is unfinished.

End active visits, then use **Pause target for import** to stop the target simulation. Select a
package and an import mode, then run authoritative server preflight. Use **Resume target
simulation** after recovery. A fresh empty clone target does not require an existing world to pause.
The report shows scope, counts, conflicts and the required vector rebuild. Changing the file, mode
or migration options or target world state invalidates the report. Import is enabled only after
successful preflight and review of that concrete report.

- **Restore this town** requires the target's existing long-term identity, matching source
  fingerprint and explicit confirmation that the source deployment is stopped.
- **Migrate this town** also requires the source deployment to be stopped. Do not run two active
  instances with the same identity.
- **Create a new town** requires an empty target and its new HTTPS endpoint. It creates a new
  identity instead of impersonating the source.
- **Merge as new residents** imports into the default target world and assigns destination-owned
  global identities.

Before restore or migration, the browser downloads a backup of the current target. Import results
show actual document-ID mappings and required vector rebuilding. Imported live leases are not
reactivated, historical peers are not automatically trusted, and missing provider credentials do not
silently change model bindings. The import history lists completed backend operations.

### Restored traveler reconciliation

The **Restored travelers awaiting reconciliation** section lists residents restored with
`NEEDS_RECONCILIATION`. It shows their original global identity, target world, historical visit ID,
safe return deadline and any missing evidence or paused-world requirement. The countdown updates
locally; the server independently verifies the real deadline when recovery is requested.

A snapshot may predate a newer lease granted by the old source. The deadline therefore covers the
recorded host leases, proposed extensions and the stopped-source confirmation plus the configured
maximum visit duration, followed by a safety margin. Importing a snapshot never authorizes immediate
return.

Confirm that the old source is stopped and cannot renew leases, pause the resident's target world,
then use **Reconcile & return home** after the safe time. Missing evidence blocks the operation
instead of creating a duplicate. The backend restores the same resident identity and model binding,
records the recovery, and leaves old authorizations inert. Resume the target simulation after all
required recovery checks are complete.

Canonical memories and relationships are retained. **Storage policy** shows paginated serialized-size
estimates and configurable category budgets, warnings, cache retention and vector rebuild batch
sizes. Capacity limits pause nonessential cache and rebuild writes while preserving canonical data.
Safe cleanup retains unacknowledged messages, active visits and referenced inputs; terminal action
and event records are compacted into durable facts before operational records are deleted.

Cold archive location is configuration metadata; backup frequency produces a due reminder. These
settings do not upload to an external storage service or automatically stop a live town for backup.
Only completed, verified large exports update the last verified backup time. Usage estimates are
not Convex physical billing measurements or a single atomic snapshot.

Host decision wait is configurable from 5 to 120 seconds (default 25). Set it to match the Home
model SLA. Every reply remains bounded by the visit lease; expired replies cannot execute.
