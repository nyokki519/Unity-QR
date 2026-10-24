# Unity CHECK-IN architecture

## Isolation
This service is independent from Unity DROP. Do not import or modify DROP draw, inventory, video, or Worker logic.

## Data model
### members
- memberId (server generated, e.g. U0001)
- lineUserId (internal only, unique)
- displayName
- lineDisplayName
- pictureUrl
- memberSince
- createdAt
- status

### events
- eventId (server generated)
- title
- date
- startTime
- location
- status
- checkinTokenHash (optional rotating event QR token)

### checkins
- checkinId
- memberId
- eventId
- checkedInAt
- unique(memberId,eventId)

## Production authentication
LINE authentication is deliberately separated from the UI. Production should use LINE Login/LIFF and send the LINE-issued credential to the CHECK-IN backend. The backend validates the credential and resolves lineUserId -> memberId. The browser must never be trusted to choose memberId.

Required before enabling LINE mode:
- LINE Login channel
- Channel ID
- LIFF app / LIFF ID (if LIFF is selected)
- Endpoint URL / callback URL
- server-side channel secret where required

Never commit channel secrets/access tokens to this public repository.

## Check-in API target
- POST /api/auth/line : validate LINE identity, return short-lived CHECK-IN session
- GET /api/me : current member profile
- GET /api/events/today : eligible event(s)
- POST /api/checkins : authenticated check-in; event eligibility and duplicate prevention server-side
- GET /api/me/history : member history

For venue QR, use `/checkin?event=<public-event-id>&token=<short-lived-event-token>`. The server validates both the authenticated member and event token. A changed memberId/eventId in the browser must not authorize a check-in.

## Current demo
The current frontend intentionally uses DEMO MEMBER/localStorage so visual and interaction work can continue without inventing LINE credentials. This is not production identity or production attendance storage.
