# Moving the Viswachakra scraper to a new computer

Only the **scraper** runs on a computer. The web dashboard (Vercel) and the
database (Supabase) are already in the cloud and do NOT move.

## Requirements for the new computer (all important)

- **Indian internet connection (residential is safest).** The portal blocks
  foreign / datacenter IPs, so the machine MUST be on an Indian ISP.
- **Always on and online** during the hours you want it to sync.
- Windows, with these installed once:
  - **Node.js** (LTS) — https://nodejs.org
  - **Google Chrome** — the scraper drives a real Chrome window
  - **Git** — https://git-scm.com/download/win

## Step 1 — Get the code

Open a Command Prompt and run:
```
cd %USERPROFILE%\Downloads
git clone https://github.com/VVISTECH-git/viswachakra.git
cd viswachakra
npm install
```

The folder can live anywhere — `run-hourly-sync.bat` and `run-refresh.ps1`
locate themselves, so no paths need editing. Note the full path you chose;
Step 5 needs it.

You do NOT need `npx playwright install`. The scraper launches the real
installed Google Chrome (`chromium.launch({ channel: 'chrome' })`), so
installing Chrome from Step 0 is enough.

## Step 2 — Create the .env file

In the `viswachakra` folder, create a file named `.env` (exactly that, no .txt)
with these 5 lines. **Use the CURRENT portal password** — copy it from the old
machine's `.env` if it was changed since:

```
LOGIN_URL=https://app.drntrvaidyaseva.ap.gov.in/ASRI/
VAIDYA_USERNAME=medco1_vcoh_mtm
VAIDYA_PASSWORD=<the current portal password>
SUPABASE_URL=https://lxeuvxkhieszizdclivg.supabase.co
SUPABASE_SERVICE_KEY=<the sb_secret_... key from the old machine's .env>
```

## Step 3 — Stop the scraper on the OLD machine

The portal allows only ONE session per account. Do NOT run the scraper on two
machines at once. On the old (Hyderabad) machine, close any backfill window and
delete/disable its scheduled task. Check BOTH names — older installs registered
it as "Viswachakra Sync", the current one is "ViswachakraHourlySync":
```
schtasks /query /tn "ViswachakraHourlySync"
schtasks /change /tn "ViswachakraHourlySync" /disable
```

## Step 4 — Catch up the history (one-time)

The database already has data up to ~May 2023 backward. To fill the rest and
refresh, run:
```
node scraper.js --from "01/01/2023 00:00" --headless
```
It resumes safely (already-scraped cases are updated, not duplicated) and pushes
to Supabase after each chunk. Keep the window open; keep the machine awake.

There is no separate `backfill.js` any more — it was folded into `scraper.js` in
commit 80c1214. Date format is DD/MM/YYYY HH:mm. Add `--to "..."` to cap the
range, or `--limit all` to lift the row cap.

## Step 5 — Turn on the automatic hourly sync (the permanent fix)

This is what stops the "it keeps stalling" problem — it auto-restarts every hour.
Open an **Administrator** Command Prompt and run (adjust the path if the folder
is elsewhere):
```
schtasks /create /tn "Viswachakra Sync" /tr "%USERPROFILE%\Downloads\viswachakra\run-hourly-sync.bat" /sc hourly /rl highest /f
```
Then, for reliability, open **Task Scheduler**, find "Viswachakra Sync" →
Properties, and tick:
- General → **Run whether user is logged on or not**
- Conditions → **Wake the computer to run this task**
- Settings → **Run task as soon as possible after a scheduled start is missed**
- Settings → **If the task fails, restart every 5 minutes, up to 3 times**
- Settings → **Do not start a new instance** (if already running)

## Checking it works

- Run history: Task Scheduler → "Viswachakra Sync" → Last Run Result.
- Logs: `logs\hourly-sync.log` in the folder.
- Live data: it should appear on the dashboard at https://viswachakra.vercel.app
- To update the code later: `git pull` then `npm install`.
