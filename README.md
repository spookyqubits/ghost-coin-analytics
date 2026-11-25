# Ghost Coin Level 2 classroom pilot

SpookyQubits classroom analytics for **The quantum trick**. Start with a synthetic class and two independent browser profiles. Completion defaults to one resolved round and applies to either outcome.

- **Student launch** `games/ghost-coin.html?classroom=1`
- **Instructor dashboard** `instructor.html`
- **Public play** `games/ghost-coin.html`

Add these paths to the base URL shown in GitHub Pages. The standalone game is based on the published [Ghost Coin source](https://github.com/spookyqubits/Ghosts_and_Gates/blob/main/games/ghost-coin.html), from SpookyQubits and Dr. Elahe Javadi. The published game's artwork, rules and credits are retained in the classroom copy.

## Set up a class

1. Use a dedicated Supabase project. In SQL Editor, run [the Level 2 migration](supabase/migrations/202611250001_ghost_coin_level_2.sql) once. It creates private tables with row-level security and authenticated RPCs for enrollment, event ingestion, reporting and class management. The account that runs the migration owns those functions. PostgREST serves them over HTTPS.
2. Copy the project URL and **publishable** key into [analytics/config.mjs](analytics/config.mjs). Keep administrative keys and database credentials in Supabase. Enable anonymous sign-ins for students under Authentication. The class code is an enrollment gate. Supabase recommends CAPTCHA or Turnstile for broader anonymous sign-up. This pilot uses a random class code, per-account RPC limits and the project's Auth rate limits. Check [anonymous sign-in guidance](https://supabase.com/docs/guides/auth/auth-anonymous) before expanding beyond a small class.
3. Add the student and instructor site's HTTPS **origin** to the SQL setting below. For a local preview, add `http://localhost:8080` temporarily. Supabase's Data API handles CORS preflight. The RPCs reject browser origins outside this allowlist and still require authentication and ownership. A direct authenticated API client's Origin header is optional.
4. In Supabase Authentication → Users, create an email/password account for the intended instructor and confirm the account. Run the ownership-grant SQL below with the instructor email. For email-link sign-in, configure the dashboard URL as an authorized redirect and set up email delivery for that recipient. The [default Supabase mail service](https://supabase.com/docs/guides/auth/auth-smtp) delivers only to project-team addresses and is rate-limited.
5. In the pilot repository, publish the root of `main` under Settings → Pages. Open the student and instructor paths over HTTPS. The pilot can use its own GitHub Pages URL without changes to the production domain. GitHub documents [Pages publishing sources](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site).
6. Sign into the instructor dashboard and choose **New class**. Save the class name and number of rounds required. Copy the displayed class code and share it with the class. A code is shown only when created or rotated. Rotating replaces the code used for future enrollments. Turning off **Accept enrollment and saves** blocks new enrollments and pending uploads for that class.
7. Verify deployment with two synthetic students in different browser profiles and a provisioned instructor. Resolve a round, including a loss, and confirm that credit is saved and the instructor's timeline and CSV agree. Switch away from Level 2, hide the tab, leave it idle and interrupt a save. Confirm timing pauses and a retry retains the same event IDs. Verify that a student cannot read student records or write to another session, and that instructors can open only their own classes. Collect real names after those checks pass.

```sql
update gca_private.settings
set allowed_origins = array['https://your-account.github.io']
where singleton;

insert into gca_private.instructors (user_id)
select id from auth.users
where lower(email) = lower('instructor@example.edu')
  and email_confirmed_at is not null
  and not is_anonymous
on conflict do nothing;
```

Check that the instructor statement added one row before sign-in. A verified project Auth user without an instructor membership cannot read any class records.

## Preview and test

Serve the pilot folder with `python3 -m http.server 8080 --bind 127.0.0.1` and open `http://localhost:8080/games/ghost-coin.html?classroom=1`. Public play and the Level 2 preview work with a blank configuration. To exercise live saves locally, use a dedicated test project and authorize the local origin before enrolling synthetic students.

Run `node --test tests/*.test.mjs` for the built-in checks. The PostgreSQL integration check also runs when `GCA_PGLITE_DIR` points to the `dist` folder of an installed `@electric-sql/pglite` package. The mocked browser workflow runs when `GCA_PLAYWRIGHT_DIR` points to the installed `playwright` package. Set `GCA_CHROME` to a Chromium executable if Playwright's bundled browser is unavailable. These checks exercise deployed code paths in a local test environment. Repeat the live checks before a class.

Supabase currently lists two active Free projects, 500 MB per project database, 5 GB egress and pausing after a week of inactivity. Check the [current plan limits and status](https://supabase.com/pricing) before the workshop.

## Review, export and delete

- Choose a class, then select **View** for an individual session. A shared-device session displays both names and one set of timings. A reload starts a new session. Rejoining from the same anonymous browser identity with the same names and class preserves earned credit.
- Download **Export class summary** and **Export class events** separately. The summary includes names. The events file links by opaque session ID. Keep exports in an authorized location and apply the same retention rules as the database.
- **Export card plays** downloads one row per saved Level 2 card choice, including abandoned and unresolved rounds. The four coin-state columns use 0 for an empty box and 1 or -1 for the chip's sign. Probability and outcome are blank when the round has no saved resolution. Use `session_id` or `participant_id` to link the card plays to the class summary. The card export contains no names.
- **View quantitative report** shows the selected class's saved card choices by actor, round starts and resolutions, enrollments with credit, and Heads and Tails counts for each completed sequence. Pacing uses separate medians for the time before and after the final card and groups rounds by whether the game resolved moves automatically. The report uses the existing instructor sign-in and database permissions.
- Set the retention period before the pilot. To delete a participant, view a session and choose **Delete participant and activity**. Deleting removes both names, every linked session, events, and completion credit. Delete corresponding exports and apply the project's backup retention separately. In this dedicated project, administrators can remove an unused anonymous Auth user in Authentication after checking that it has no other participant records.
- The active and idle estimates use meaningful game input and the 60-second cutoff in `analytics/timing.mjs`. Hidden time is separate. The ledger uses the latest cumulative timing snapshot and bounds an interrupted session at the last saved observation. Shared-device time belongs to the session. A round that resolves while the player is in the Chip Lab falls outside the tracking scope.
- The browser keeps unacknowledged events for up to two days subject to storage availability. The queue carries opaque IDs and event details. The server checks the selected cards, state transitions and recorded result before issuing completion credit. Telemetry remains self-reported.
