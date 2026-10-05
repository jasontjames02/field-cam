# Field Capture

Guided, unit-by-unit job-site photo capture for an iPhone. It records which unit every photo
belongs to as it is taken, uploads each photo to OneDrive seconds later, and writes a
`PHOTO_MAP.json` that the assessment tooling reads instead of guessing unit boundaries.

Live app: https://jasontjames02.github.io/field-cam/ (GitHub Pages, served from `main`, no build step).

## Rules for working on it

- **Clone this repository and build from `HEAD`.** Never build from a zip or a folder copy on a
  PC. A rebuild from a stale copy on 2026-08-19 silently dropped a week of work.
- **`main` is the live app.** Merging to `main` is the release.
- Every release bumps `APP_VERSION` / `APP_BUILT` in `index.html` **and** `BUILD` in `sw.js`.
  A service worker whose file does not change is never replaced.
- The scope codes in `index.html` (`SCOPES`) and the list in the map verifier
  (`read_photo_map.py`, `SCOPE_ATOMS` / `SCOPE_COMPOUND`) are one list in two places. They change
  together, or maps using a new code are rejected.
- The app is called **Field Capture**. No company name appears anywhere in it.

## Files

| File | What it is |
|---|---|
| `index.html` | The whole app: markup, styles and script |
| `config.js` | Optional shared settings (client ID, account type, destination folder, account, pinned drive id). A value set here cannot be changed in the app, so every phone and browser agrees. The app writes this file for you: Settings → Copy config.js contents |
| `sw.js` | Offline shell. Network first, stored copy when there is no signal. A release only takes over once `index.html` and `config.js` are stored |
| `manifest.webmanifest`, `icon-*.png` | Home-screen install |
| `test/` | End-to-end tests (below) |

## What the app guarantees

1. **Photos only go to one OneDrive.** The first sign-in shows the account, the drive id and what
   is in the destination folder, and asks once. That drive is then pinned; every upload is
   addressed to it by drive id, and a sign-in to any other drive is refused and thrown away.
   **The account is named in full in `config.js`** (`account`). A Microsoft account is its whole
   address: the same name without the part after the `@` is a different account with a OneDrive of
   its own, and an earlier build left the destination path in that one too. So sign-in sends the
   whole address, any other account is turned away before it can be offered for confirmation, and
   a OneDrive confirmed on a device for a different account is cleared when the app opens (a job
   bound to it is sent again in full). Without `config.js`, the Settings field does the same job
   and refuses a name that is not a whole address.
2. **The destination folder is never created.** If it is not in the drive, the drive is refused.
   Only the job folder (`<Insured>_<Claim>_Photos`) and its `Bldg-*` / `_site` subfolders are made.
3. **Upload as you shoot**, each file's size checked against what OneDrive reports.
   **CONFIRM IN ONEDRIVE** lists the folder back and reconciles every photo by name and size.
4. **Nothing on the phone is replaced by accident.** Starting a new job, or deleting one, takes a
   typed word unless the job is confirmed in OneDrive (or exported) at its current revision,
   including its map.
5. **The folder always matches the map.** Deleting or renumbering an uploaded photo removes or
   renames the OneDrive copy. A second visit to the same claim gets its own folder (`-2`).
6. **A unit opens on exactly one chalk-number photo**, and a unit with no photos is never declared.

## Photo map

`PHOTO_MAP.json` header: `source: "Field Capture"`, `app_version`, `app_built`, `map_schema`,
`claim.{insured, claim_no, job_no, started, buildings, unit_numbering}`, `units[]`
(`building, unit, scope, photo_count`, optional `note` for a takeoff), `photo_map[]`.
Files are named `SEQ_B<bldg>_U<unit>_<nn>-<step>.jpg`; filename sort equals shooting order.
Imported photos carry `imported: true` and, where the file records one, `original_taken`
(EXIF camera time).

A unit's chalk-number photo can be retaken at any time. The new picture replaces the old one in
place — same record, same file name, same position at the front of the unit — so the map stays
valid. `captured` keeps the moment that place was first shot (the verifier checks order by it)
and `retaken_at` records when the picture now in the file was actually taken.

## Scope codes

The picker mirrors section 4 of the assessment standard. First on the sheet, in this order:
`T FG CC WC ECON UNIT SYS`. Then `ND OOS TBD`, plus `NFD` only on a job whose policy has a
cosmetic exclusion. Under "More codes": `DUCT INS`, `DUCT`, `TRANS`, `OA HOOD`, `OA SCREEN`, the
designators `NT` and `M`, and a free-text takeoff note. `ECON` is the economizer hood; `ECON HOOD`
is the same code. `T(ECON)` and `EX` are deliberately not offered.

## Tests

`test/run.js` drives the unmodified app in headless Chromium (fake camera) against
`test/fake.js`, a local stand-in for Microsoft sign-in and OneDrive. Chromium resolves every
host name to this machine, so the test cannot reach the real services.

```
sh test/make-cert.sh
node test/run.js <site dir> <path to read_photo_map.py> [out dir] [dir holding the previous release]
```

It needs to bind port 443 and expects Playwright and sharp under `/opt/npm-tools/node_modules/`.
The run ends by feeding the uploaded folder and the exported ZIP to the real verifier, which
must exit 0. Covered: wrong OneDrive, missing destination folder, 429, expired and lapsed
sign-in, offline, corrupted and missing uploads, stray files, deleted folders, a second visit,
upgrade from v10, two tabs, a stalled camera, double taps, and the job-replacement guards.

What it cannot cover is a real iPhone: the camera, close focus on a data tag, PHONE CAMERA, the
share sheet for Save to Photos, sign-in from the home-screen app, and storage behaviour. Those
are checked on the phone after each release.

## Known platform limits (iOS)

- Microsoft allows a single-page app 24 hours per sign-in. Expect to sign in once each job day.
- A web app cannot write to the photo album by itself. **Save to Photos** hands batches to the
  share sheet; the copy exists once "Save Images" is tapped there.
- The home-screen app and a Safari tab keep separate storage. `config.js` is how they share
  settings; a job and its photos live only where they were shot.
- Safari's viewfinder cannot tap-to-focus. Data tags are shot in the viewfinder like every other
  step (JJ, 2026-10-04: the phone's own camera as the default was dropped after the first phone
  check). Up close, the AUTO lens chip is the one that focuses nearest; PHONE CAMERA is still
  there on every step for a full-size photo.

## History

| Date | Build | Note |
|---|---|---|
| 2026-07-30, 07-31 | original | |
| 2026-08-12 | 2.0 – 2.2 | Upload as you shoot, sign-in fixes, IMPORT, version in the map |
| 2026-08-19, 08-20 | v8 – v10 | Rebuilt from the July code: gained lens picker, zoom and camera wake-up, lost the 08-12 work |
| 2026-10-04 | 3.0 | v10 base with the 08-12 work restored; pinned OneDrive, reconcile, job guards, larger viewfinder, automatic next unit, current chalk codes |
| 2026-10-04 | 3.0.1 | The account is named in full in `config.js`; look-alike accounts are refused before confirmation; a wrong confirmation is cleared. Found on the first phone check: a sign-in with the name alone landed in a second account, and it was confirmed |
| 2026-10-04 | 3.0.2 | Data tags are shot in the viewfinder again; the phone's own camera is no longer the default for them and the setting is gone |
