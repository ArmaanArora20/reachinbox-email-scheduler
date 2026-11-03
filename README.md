# ReachInbox Email Scheduler

A full-stack email scheduling dashboard built for the ReachInbox
Software Development Intern assignment. The application combines a React
and TypeScript frontend with an Express and TypeScript API, PostgreSQL
persistence, Redis-backed BullMQ scheduling, and Ethereal SMTP for safe
email testing.

## Features

-   Schedule email campaigns for an immediate or future start time.
-   Import recipient addresses from CSV or TXT files; parse addresses in
    the browser and display the detected valid-recipient count.
-   Create an individual persisted email record and queue job for each
    recipient.
-   Store email content, scheduled times, statuses, and delivery errors
    in PostgreSQL.
-   Use BullMQ delayed jobs backed by Redis rather than cron jobs.
-   Configure worker concurrency, per-recipient delay, and an hourly
    sending limit.
-   Display Scheduled, Sent, and Failed email records in the dashboard.
-   Inspect queue state through Bull Board.
-   Use Ethereal SMTP to preview test messages without sending real
    outreach email.
-   Provide Google OAuth and Slack OAuth connection routes.
-   Search email records through the search API, with PostgreSQL
    fallback when Elasticsearch is unavailable.

## Technology Stack

  Area                     Technology
  ------------------------ -----------------------------------------------
  Frontend                 React, TypeScript, Vite
  Backend                  Node.js, Express, TypeScript
  Queue and delayed jobs   BullMQ, Redis
  Relational persistence   PostgreSQL
  Email testing            Ethereal Email / SMTP
  Queue monitoring         Bull Board
  Search integration       Elasticsearch client with PostgreSQL fallback
  Integrations             Google OAuth, Slack OAuth

## Requirements

-   Node.js 20 or newer
-   npm
-   PostgreSQL (hosted or local)
-   Redis (hosted or local)
-   Google OAuth credentials for Google sign-in
-   Slack app credentials for Slack OAuth and message testing
-   Elasticsearch endpoint for Elasticsearch-backed indexing and search

Docker is optional. This project can use hosted PostgreSQL and Redis
services.

## Setup (Windows / VS Code)

### 1. Configure environment variables

From the project root, create the backend environment file:

``` powershell
Copy-Item backend/.env.example backend/.env
```

Edit `backend/.env` and provide the connection details for your own
services. For example:

``` env
PORT=4000
DATABASE_URL=postgresql://USER:PASSWORD@HOST/DATABASE?sslmode=require
REDIS_URL=rediss://default:PASSWORD@HOST:6379
FRONTEND_URL=http://localhost:5173
```

Use the exact connection strings supplied by your providers. For Upstash
Redis, use the Redis connection URL (typically `rediss://`), not the
REST URL or REST token.

Keep the remaining variables from `.env.example` and configure the
relevant values:

``` env
WORKER_CONCURRENCY=3
ELASTICSEARCH_URL=http://localhost:9200

GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=http://localhost:4000/auth/google/callback

SLACK_CLIENT_ID=
SLACK_CLIENT_SECRET=
SLACK_REDIRECT_URI=http://localhost:4000/auth/slack/callback

SESSION_SECRET=replace-with-a-long-random-value
```

If the application uses Ethereal's automatically generated test account,
explicit SMTP credentials are not required. Otherwise, configure
`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_SECURE` as
appropriate.

Never commit `backend/.env` or publish credentials, access tokens, or
database URLs.

### 2. Install dependencies

Run from the project root:

``` powershell
npm run install:all
```

### 3. Start the backend

In the first terminal:

``` powershell
npm run dev:backend
```

The backend initializes the email table if it does not already exist.
The API normally runs at `http://localhost:4000`.

### 4. Start the frontend

In a second terminal, from the project root:

``` powershell
npm run dev:frontend
```

Open the Vite URL shown in the terminal, normally
`http://localhost:5173`.

### 5. Check service connectivity

``` powershell
curl.exe --max-time 6 http://localhost:4000/api/health
```

When PostgreSQL and Redis are reachable, the response should report both
services as `ok`.

Useful local URLs:

-   Frontend: `http://localhost:5173`
-   Health check: `http://localhost:4000/api/health`
-   Bull Board: `http://localhost:4000/admin/queues`

## CSV/TXT Recipient Import

In **Compose New Email**, choose a `.csv` or `.txt` file. The frontend
reads the file in the browser, extracts email addresses, places them in
the recipient field, and displays the detected valid-recipient count.
When the campaign is scheduled, the extracted recipient list is
submitted to the scheduling API.

The assignment asks for CSV/text upload, address parsing, and a count of
detected addresses; it does not require the original uploaded file to be
retained as a downloadable attachment. The current implementation parses
the file in the browser and does not persist the original CSV file.

## Scheduling and Processing

1.  The frontend submits recipients, subject, body, start time, delay,
    and hourly limit to `POST /api/emails/schedule`.
2.  The backend stores email records in PostgreSQL and enqueues delayed
    jobs in BullMQ.
3.  Redis provides queue persistence and a shared hourly counter.
4.  A worker processes due jobs and sends test messages through Ethereal
    SMTP.
5.  The backend updates each email's status and delivery information;
    the dashboard refreshes the email list periodically.

BullMQ delayed jobs are used for scheduling; no cron-based scheduler is
used. Worker concurrency is configurable through `WORKER_CONCURRENCY`.

## OAuth Configuration

### Google

Create a Web application OAuth client in Google Cloud Console and
configure the authorized callback URI to match:

``` text
http://localhost:4000/auth/google/callback
```

For local development, the frontend origin is normally:

``` text
http://localhost:5173
```

Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and
`GOOGLE_CALLBACK_URL` in `backend/.env`. Add test users in Google Auth
Platform if the OAuth application is in testing mode.

### Slack

Create an app in the Slack API dashboard. Add the following redirect URI
under **OAuth & Permissions**:

``` text
http://localhost:4000/auth/slack/callback
```

Grant the bot the `chat:write` scope and install the app to the
workspace. Set `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, and
`SLACK_REDIRECT_URI` in `backend/.env`.

The dashboard links to the Google and Slack OAuth routes. After
connecting Slack, the test endpoint can be used to verify message
posting:

``` text
POST http://localhost:4000/api/slack/test
```

The endpoint expects a connected Slack session and accepts an optional
`channel` field. For a successful test, use a channel the installed bot
is allowed to post to.

## API Reference

  ----------------------------------------------------------------------------------------------
  Method                  Endpoint                                       Purpose
  ----------------------- ---------------------------------------------- -----------------------
  `GET`                   `/api/health`                                  Check PostgreSQL and
                                                                         Redis connectivity

  `GET`                   `/api/emails?status=scheduled\|sent\|failed`   List email records

  `POST`                  `/api/emails/schedule`                         Persist email records
                                                                         and enqueue jobs

  `GET`                   `/api/search?q=...`                            Search emails

  `GET`                   `/admin/queues`                                View BullMQ queues

  `GET`                   `/auth/google`                                 Start Google OAuth

  `GET`                   `/auth/google/callback`                        Handle Google OAuth
                                                                         callback

  `GET`                   `/api/me`                                      Get the current session
                                                                         user

  `POST`                  `/auth/logout`                                 Log out

  `GET`                   `/auth/slack`                                  Start Slack OAuth

  `GET`                   `/auth/slack/callback`                         Handle Slack OAuth
                                                                         callback

  `POST`                  `/api/slack/test`                              Send a test Slack
                                                                         message

  `POST`                  `/api/slack/disconnect`                        Disconnect Slack for
                                                                         the current session
  ----------------------------------------------------------------------------------------------

Example scheduling payload:

``` json
{
  "recipients": ["person@example.com"],
  "subject": "Hello",
  "body": "Test message",
  "startAt": "2026-11-03T12:00:00Z",
  "delaySeconds": 2,
  "hourlyLimit": 100
}
```

`startAt` is optional; when omitted, scheduling begins immediately. Use
a future ISO-8601 timestamp to test delayed delivery.

## Verification

A basic end-to-end scheduling and Ethereal delivery workflow has been
tested. PostgreSQL and Redis connectivity have also been verified
through the health endpoint.

To verify persistence and delayed processing:

1.  Schedule a test email several minutes in the future.
2.  Confirm that it appears under **Scheduled Emails**.
3.  Stop the backend with `Ctrl+C`, leaving PostgreSQL and Redis
    running.
4.  Restart the backend and refresh the dashboard.
5.  Confirm the email remains scheduled and is processed at the intended
    time.
6.  Check the backend terminal for the Ethereal preview URL and inspect
    Bull Board.

For a fuller assignment review, also test Google login and logout, Slack
authorization and message delivery, rate-limit rescheduling, duplicate
prevention around restart boundaries, Elasticsearch indexing/search, and
behavior under concurrent load.

## Implementation Notes

The core scheduling flow, database records, Redis/BullMQ queue
integration, dashboard lists, CSV/TXT parsing, and Ethereal test
delivery are implemented. The project also includes OAuth routes and a
Slack test-message endpoint.

Some behaviors depend on external service configuration and dedicated
end-to-end verification. Elasticsearch indexing is best-effort and the
API falls back to PostgreSQL text matching when Elasticsearch is
unavailable. Slack OAuth currently keeps its bot token in the session
rather than durable, encrypted per-user/per-tenant storage; automated
Slack notification on hourly rate-limit events is not wired through as a
verified end-to-end flow. The default Express session store is
in-memory, so session state does not survive backend restarts. These are
important distinctions when evaluating the prototype against every
assignment requirement.

## Repository Hygiene

-   Keep secrets in `backend/.env`; commit only `.env.example` with
    placeholders.
-   Do not commit database credentials, OAuth secrets, Slack tokens, or
    SMTP passwords.
-   Use a persistent session store and secure cookie settings before
    deploying beyond local development.
