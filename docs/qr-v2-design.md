# Unity QR 2.0 design

## Goal and boundary

Build a practical iPhone-first operator reception system while preserving the deployed member demo, its storage, assets and routes. The user explicitly requested autonomous implementation; design and plan review gates are replaced by documented decisions, not repeated approval requests. Use one existing isolated checkout and no additional implementation agents.

## Architecture

Add `/ops/` with six views: dashboard, scanner, participants, events, history and settings. Deep green, ivory and champagne; the existing U seal and serif heading language; large touch targets, safe areas, no required animation. Root legacy frontend is unchanged. Plain client JS uses an authenticated TypeScript Node server; SQLite owns reception data and transactions on a persistent local volume. Node 24+ is required. Stateless/serverless ephemeral filesystems are unsupported.

Authentication uses scrypt password hashes, random opaque server sessions with expiry, HttpOnly/Secure/SameSite cookies, same-origin writes and per-IP login throttling. Admin has all functions; Staff can view assigned events, issue tickets/register walk-ins and check in; Viewer has read-only access to assigned events. Only Admin can edit existing names, cancel registration or undo attendance. No default production credentials or unauthenticated participant access.

Events have reception windows, capacity, venue and external source+ID uniqueness. Participants have server UUIDs and optional unique shared member IDs; same names do not merge. Registrations distinguish planned/cancelled, attendance checked-in or undone. A unique event/participant row plus idempotency keys, transactionally coupled audit and sync outbox prevent double counting. Capacity blocks new arrivals, not duplicate receipt retrieval. Event time and QR expiry are checked at the server.

Tickets are HMAC-signed versioned payloads with event, participant, issuer, audience and expiry. Browser scanner prefers environment camera, uses native BarcodeDetector where supported and locally bundled jsQR otherwise; cleans up tracks, pauses on background, displays errors and supports pasted ticket/manual participant search. Client feedback occurs only after confirmed API response. Network failures retain an idempotency key for retry. No offline success queue.

## Integration

Analytics uses an explicit versioned snapshot/import and change delivery contract, not undocumented deployed endpoints. Imported events/registrations are idempotent by external IDs; reception states and history are never overwritten. Import preview counts and recorded sync runs make changes inspectable. Attendance/undo changes use outbox IDs as remote idempotency keys; failed delivery is visible and retried with bounded backoff. No PV/application snapshot tables are touched.

PASS is a server-side verification adapter, disabled without real HTTPS endpoint and credential. It must return a stable member ID and matching event for the presented signed ticket; the QR server checks expiry and maps only existing registered members. Unconnected PASS never invents an identity and does not break ordinary tickets. API details are recorded in the integration document.

## Verification and rollout

Test isolated temporary databases and API servers: roles, CSRF, auth expiry, QR tamper/expiry/event mismatch, concurrent duplicate check-ins, undo audit, filters, import preservation, outbox retries and backup restoration. Decode an actual generated QR. Run legacy 15-check suites plus `/ops/` Chromium and WebKit flows. No real attendee or production event is created. Real camera/iPhone and external integration require actual host verification; stop before production when unavailable.
