# ATELIER — Full Website + Admin Dashboard

This project keeps the existing ATELIER public website design and adds a Node.js/Express backend, PostgreSQL database, contact enquiry storage, and a password-protected admin dashboard.

## Included features

- Existing public website design retained in `public/index.html`.
- Projects stored in PostgreSQL and rendered on the public site.
- Admin dashboard at `/admin` to add, edit, feature, and delete projects.
- Project fields include category, location, scale, credits, source, image URLs, overview, concept, challenges, and materials.
- Contact form submissions are validated and stored in PostgreSQL.
- Admin dashboard can view, filter, mark as read, archive, and delete enquiries.
- Site Settings tab edits studio contact details and selected homepage copy.
- Admin authentication uses an HTTP-only signed session cookie. There is no public registration.
- PostgreSQL tables are created automatically on first boot, and the three supplied project references are seeded only when the projects table is empty.

## Run locally

1. Install Node.js 20 or newer.
2. Create a PostgreSQL database.
3. Copy `.env.example` to `.env` and set `DATABASE_URL`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, and a long random `JWT_SECRET`.
4. Run `npm install`.
5. Run `npm start`.
6. Open `http://localhost:3000` for the site and `http://localhost:3000/admin` for the dashboard.

## Deploy to Railway

1. Push the contents of this folder to a GitHub repository (upload the files inside the folder, not the ZIP itself).
2. In Railway, create a new project and deploy from the GitHub repository.
3. Add a PostgreSQL database to the same Railway project.
4. In the website service Variables, add a reference to the PostgreSQL service's `DATABASE_URL` variable.
5. Add these variables to the website service:
   - `ADMIN_USERNAME` — choose a username.
   - `ADMIN_PASSWORD` — choose a long, unique password.
   - `JWT_SECRET` — use a long random secret (at least 32 characters).
   - `NODE_ENV` — `production`.
6. Railway detects `package.json` and runs `npm start`. The health check is `/api/health`.
7. Generate a Railway domain from the service's Settings / Networking section.
8. Visit `/admin` on your deployed domain and sign in with the credentials you configured.

Do not upload `.env` or commit real passwords/secrets to GitHub. Railway's `DATABASE_URL` should be supplied as a variable reference, not hard-coded in source files.

## Admin routes

- `/admin` — dashboard UI.
- `/api/admin/projects` — project management.
- `/api/admin/messages` — contact enquiries.
- `/api/admin/settings` — editable public site settings.

## Notes

- Project photos are currently referenced by external image URLs. Confirm usage rights before using third-party photography in a commercial portfolio.
- The final personal contact line already present on the public site remains separate from the editable studio contact details.
- The public contact form stores messages in PostgreSQL; it does not send an email notification. The admin dashboard is where submitted enquiries can be reviewed.


## Regression tests

Run `npm ci` and `npm test`. Tests exercise the HTTP API against an in-memory
PostgreSQL emulator and render the public UI in JSDOM. They do not connect to the
production database. A real PostgreSQL deployment remains the final integration check.

Projects can be reordered with the up/down controls in the dashboard. Project IDs
are immutable after creation. Project image and source URLs must use HTTP(S).
Client enquiries are paginated in groups of 50 and show the total unread count.
Project links use `#project-<id>` and support browser back/forward navigation.

Initial reference projects are seeded once, tracked by the `app_migrations` table.
On an existing installation the first upgraded startup records the migration and
preserves existing projects. Once recorded, deleting all projects keeps the site empty.
