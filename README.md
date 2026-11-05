# Ghoulette: Spin the Séance (Halloween random video chat)

## Run locally
    npm install
    npm start
Open http://localhost:3000 in two browser windows and click "Enter the Crypt" in both.

## Deploy (Render)
1. Put this folder in a GitHub repo.
2. Render.com > New > Web Service > pick the repo.
3. Build command: `npm install`   Start command: `npm start`
4. Deploy, then add your custom domain under Settings > Custom Domains (HTTPS is automatic).

## Optional TURN relay (recommended for public launch)
Set these environment variables on the host:
    TURN_URL=turn:your.turn.server:3478,turns:your.turn.server:443?transport=tcp
    TURN_USER=...
    TURN_PASS=...

## Before going public
Real age verification, moderation, a Terms of Service and Privacy Policy, and a
process for reporting illegal content (in the US, to NCMEC). Bans here live in
memory and reset on restart; use a database for production.
