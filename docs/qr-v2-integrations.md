# QR 2.0 integration contracts

These are **proposed adapter contracts**, not claims that Unity PASS or Analytics currently exposes these APIs. No other repository has been changed. All URLs/tokens are configured on the server; never in client JS. Integrations require HTTPS, reject redirects and use bounded responses/timeouts.

## Analytics snapshot v1

`ANALYTICS_SNAPSHOT_URL` may return this document to a Bearer-authenticated GET; alternatively an Admin can paste the same JSON into Settings, review counts and confirm.

```json
{
  "version": 1,
  "events": [{"externalId":"stable Analytics events.id", "title":"Event title", "startsAt":"ISO timestamp", "opensAt":"ISO timestamp", "closesAt":"ISO timestamp", "capacity":50, "venue":"Actual venue"}],
  "participants": [{"externalId":"stable Analytics participants.id", "name":"Verified participant name"}],
  "registrations": [{"eventExternalId":"matching events externalId", "participantExternalId":"matching participant externalId"}]
}
```

`source='analytics'` + stable external ID is unique in both local domains. Same names remain different people. Imports are transactional and only insert missing records/registrations; they do not rename existing people, undo arrivals, reopen cancellations, replace local reception windows or modify Analytics snapshots. Duplicate IDs or dangling registration references reject the whole input. Limits: 1MB JSON, 1,000 events, 5,000 participants, 10,000 registrations. Existing attendance is **not** treated as a planned registration without an explicit operator-approved export.

The audited Analytics source has `events.id`, `tunagate_event_id`, `participants.id`, `external_key`, and `event_attendance`; it does not establish an available planned-participant API. Do not synthesize planned registrations from PV or application counts. A mapping/export from its real registration data must supply the above contract. Existing imported metadata updates require explicit local Admin edits.

## Attendance outbox v1

`ANALYTICS_CHECKIN_URL` receives authenticated POST, header `Idempotency-Key: changeId` and the JSON below. `ANALYTICS_API_TOKEN` is sent only as Bearer auth.

```json
{
  "version":1,"changeId":"server UUID","sequence":1,"eventId":"QR event UUID","participantId":"QR participant UUID",
  "externalEventId":null,"externalParticipantId":null,"memberId":null,
  "action":"checkin","occurredAt":"ISO timestamp"
}
```

`action` is `checkin` or `undo`. The receiver must persist changeId uniquely and atomically update a separate actual-attendance projection. Respond `{"accepted":true,"changeId":"same UUID"}` only after durable acceptance; a duplicate must return the same acknowledgement. Missing external IDs must be handled explicitly by a receiver, never matched by name. A later undo/recheck is a new change; ordinary duplicate scans do not enqueue another change.

The QR server retains disconnected/failed jobs, retries each minute with exponential delay capped at one hour, and exposes failed/pending counts and sync runs to Admin. Each mutation has a durable monotonically increasing sequence; a later change for the same participant/event cannot pass an unacknowledged predecessor, even if that predecessor is waiting for retry. The receiver should retain sequence to prevent stale projections. The Admin retry command resets failed delay. Run only **one QR server process** per SQLite DB; this is not a distributed queue. PV/applications/CVR registration tables must remain unchanged. Until that receiver exists, leave delivery URL/token unset.

## Unity PASS verification v1

Configure `PASS_VERIFY_URL`/`PASS_API_TOKEN` only for a real PASS implementation. Scanner input uses `pass:<opaque PASS ticket>` to distinguish it from ordinary Unity QR HMAC tickets. Verification POST sends `{"version":1,"ticket":"opaque ticket","eventId":"QR event UUID"}` with Bearer auth. The actual PASS verifier must authenticate/signature-check the ticket and return `{"version":1,"memberId":"stable shared member ID","eventId":"same QR event UUID","expiresAt":<epoch milliseconds>}`.

QR rejects wrong event, empty/oversized member ID and expired or more-than-24-hour future expiry. It then resolves the shared member ID to an existing registered local participant; it does not invent or auto-register a member. Admin can link a verified shared member ID during registration through the server API. PASS credentials and ticket verification are never delegated to the browser. PASS history reflection can use the same durable attendance outbox after a real receiver contract is agreed; it is **not connected in this release**.

Unconfigured PASS returns `pass_disconnected`; ordinary tickets and manual reception remain available. This adapter does not add LINE Login; the preserved frontend remains an explicitly separate demo. Previous Analytics LINE PR is unmerged, so no real LINE service is assumed.
