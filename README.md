# NOW

A single-page personal web app that tells me what I should be doing **right now**
based on the day and time, lets me check off the day's tasks, and persists those
checkmarks to Supabase so they survive refreshes and sync across devices.

Mobile-first. Built to live on the iPhone home screen as a PWA. No framework,
no build step — just static files.

---

## Files

| File                   | Purpose                                                        |
|------------------------|---------------------------------------------------------------|
| `index.html`           | Markup + PWA meta tags                                         |
| `style.css`            | Design tokens, NOW-card states, checkbox styling              |
| `schedule.js`          | **Data only** — time blocks, training types, per-day tasks    |
| `app.js`               | Engine — computes "now", renders, check-offs, minute tick     |
| `supabase.js`          | Supabase URL + key + 3 REST helpers (fail-silent if offline)  |
| `manifest.webmanifest` | PWA manifest                                                  |
| `icon.svg`             | App icon                                                      |
| `schema.sql`           | Supabase table + RLS policies                                 |

To change the schedule or tasks, edit **`schedule.js`** — it's plain data.

---

## Setup

### 1. Supabase

The URL and key are already wired into `supabase.js`. You just need to create
the table:

1. Open your project → **SQL Editor** → **New query**.
2. Paste the contents of [`schema.sql`](./schema.sql) and click **Run**.

That creates the `task_completions` table, an index, enables Row Level Security,
and adds policies letting the `anon` (publishable) key read/insert/delete
completions. Safe to re-run.

> The publishable key in `supabase.js` is meant to be public — that's what it's
> for. Access is constrained by the RLS policies. Never put the `service_role`
> key in this repo.

To point at a different project, edit the two constants at the top of
`supabase.js`:

```js
const SUPABASE_URL = 'https://<your-project>.supabase.co';
const SUPABASE_KEY = 'sb_publishable_...';
```

### 2. Deploy to GitHub Pages (via `gh` CLI)

From this folder. Requires the [GitHub CLI](https://cli.github.com/) authenticated
(`gh auth login`).

```bash
git init
git add .
git commit -m "NOW assistant"

# Create the repo (private is fine — Pages still serves it) and push.
gh repo create now-assistant --private --source=. --push

# Turn on GitHub Pages from the main branch, root directory.
gh api -X POST repos/{owner}/now-assistant/pages \
  -f "source[branch]=main" -f "source[path]=/"

# Get the live URL (give Pages ~30–60s to build first).
gh api repos/{owner}/now-assistant/pages --jq .html_url
```

Replace `{owner}` with your GitHub username (or run `gh api user --jq .login`).
The live URL looks like `https://<username>.github.io/now-assistant/`.

> If `gh api ... /pages` returns 409/404 the first time, wait a moment and
> re-run — Pages provisioning can lag a few seconds after the push.

### 3. Add to iPhone home screen

1. Open the live URL in **Safari**.
2. Tap **Share** → **Add to Home Screen**.
3. Launch it from the icon — it opens full-screen, no browser chrome.

---

## How it works

- **Now / Up next** are computed from the device's local clock (`new Date()`),
  so the time zone is always yours — nothing is hardcoded.
- **Check a box** → upserts a row `(task_key, today)` to Supabase.
  **Uncheck** → deletes it.
- **On load** → fetches today's completions and applies the checked state.
  The schedule renders instantly; the DB sync happens in the background.
- **Every minute** the "now" block recomputes. Crossing **midnight** rebuilds
  the task list for the new day and clears yesterday's checkmarks from view
  (the old rows stay in the DB as history).
- **Offline / Supabase down** → fails silently. Checkboxes still work locally
  (in memory); the next check/uncheck made while online syncs.

---

## Editing the schedule

Everything lives in `schedule.js`:

- `WEEKDAY_BLOCKS` / `WEEKEND_BLOCKS` — the time blocks. Times are
  minutes-from-midnight via the `H(hour, minute)` helper.
- `TRAINING_BY_DAY` — which training fills the 10:00–13:00 weekday slot.
- `DAY_LABEL` — the tag shown on the NOW card.
- `TASKS_BY_DAY` — the checkable tasks per weekday. Each needs a stable, unique
  `key` (it's the DB primary identifier — changing a key orphans old history).

Tags (`tiktok` / `meta` / `weekend`) are color-coding only.
