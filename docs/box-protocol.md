# Box ↔ CMS ↔ eslink protocol (v1)

The contract between **esTV Custom Launcher** (Android, `com.excel.estvlauncher.custom`) and
**estv-custom-launcher-cms** (Node, hotel CMS PC), plus the launcher's eslink fallback.

All box ↔ CMS calls are plain HTTP on the hotel LAN: `http://<cms_host>:<cms_port>` (default port **4053**).
A new box starts with CMS host **172.19.0.3**, port 4053. The technician can change it in the Secret Menu.

## 1. Check-in (every 5 minutes, at boot, on network up, and on "Check now")

`POST /api/box/checkin`, `Content-Type: application/json`

```json
{
  "protocol": 1,
  "mac": "AA:BB:CC:DD:EE:FF",
  "ip": "172.19.0.57",
  "box_name": "Lobby TV 1",
  "launcher": { "version_code": 1, "version_name": "1.0.0" },
  "apps": [ { "package": "com.example.player", "version_code": 12, "version_name": "2.1" } ],
  "buttons_source": "cms",
  "buttons_rev": 3,
  "apk_results": [ { "apk_id": 4, "state": "installed", "message": "" } ],
  "firmware": "HGC.12June.v1.5",
  "android": "9",
  "display": { "scale": 92, "mode": "1080P 60Hz", "modes": [ "720P 60Hz", "1080P 60Hz", "4K2K 60HZ" ] },
  "autostart": { "package": "com.optisigns.playe1", "activity": "", "source": "cms", "rev": "h2.b0" }
}
```

- `mac` is required: upper case, colon-separated, the box's identity. Ethernet MAC first, else WiFi.
  Android 10+ hides the MAC from apps. Without root, the launcher sends a stable locally administered
  stand-in made from ANDROID_ID, starting with `02:`.
- `apps` never includes the launcher's own package, which is sent in `launcher`.
- `apps` lists the installed version of each package the CMS asked about. Those are the button packages
  plus the APK packages from the last answer. A package that isn't installed is sent with
  `version_code: 0` and `version_name: ""`.
- `buttons_source` is `"cms"` when the box shows the CMS list, or `"local"` when it was changed in the
  Secret Menu. `buttons_rev` is the CMS revision the box last applied.
- `apk_results` lists install results since the last successful check-in.
  `state` is `installed` or `failed` (failed comes with a `message`). The box clears the list once the
  CMS has answered `ok: true`.

Answer `200`:

```json
{
  "ok": true,
  "protocol": 1,
  "property_id": "2152130425",
  "property_name": "Hotel X",
  "interval_sec": 300,
  "wallpaper": { "hash": "<sha256 hex>", "url": "/api/box/wallpaper/<hash>" },
  "buttons": { "rev": 3, "list": [ { "name": "Movies", "package": "com.example.player", "activity": "" } ] },
  "display": { "scale": 94, "mode": "1080P 60Hz" },
  "autostart": { "rev": "h2.b0", "package": "com.optisigns.playe1", "activity": "", "delay_sec": 10, "relaunch_min": 10 },
  "apks": [ { "apk_id": 4, "package": "com.excel.estvlauncher.custom", "version_code": 2, "version_name": "1.0.1",
              "sha256": "<hex>", "size": 4567890, "url": "/api/box/apk/4" } ]
}
```

- `wallpaper` is `null` when no wallpaper is set: the box shows its built-in default.
  The box downloads the file when the hash differs from the one it cached.
- `buttons.list` excludes **Menu**, which the box always shows first. An empty `activity` means "the
  package's launcher activity". The box replaces its buttons when `rev` differs from the rev it last
  applied, even if they were changed locally (the newest change wins). It keeps local buttons while `rev`
  is unchanged.
- `apks` holds the newest active APK per package. The box installs one when the package's installed
  `version_code` is lower, or when the package isn't installed. It doesn't retry an `apk_id` that failed
  until the CMS sends a different `apk_id` for that package, or the technician presses Check now.
- `property_id` is stored on the box for the eslink fallback.
- `display` (CMS 1.0.2 / launcher 1.0.2) is the screen size and resolution this box should have. The box's own
  setting on the CMS wins over the hotel's. `scale` 0 and `mode` "" mean "leave it as it is". The CMS leaves out
  a hotel resolution that this box's TV doesn't report. The box applies each target once. A target it fails to
  apply isn't retried every 5 minutes (that would make the picture flicker). "Check now" applies it again.
  In the check-in, the box reports its current `scale` (%), `mode` and the `modes` its TV supports, read through
  the firmware's android.os.DisplayOutputManager (as esTVLauncher's "Adjust Screen Size" does). A box without
  that API sends no `display`.
- Errors are a non-200 status or `{ "ok": false, "error": "..." }`.

- `autostart` (CMS 1.0.4 / launcher 1.0.4) is the app this box opens by itself. `package` "" means none.
  `rev` changes whenever the hotel setting or this box's own setting on the CMS changes. It works like the
  buttons rev: when `rev` differs from the rev the box last applied, the box takes `package` / `activity` and
  sets source `cms`. An app chosen in the Secret Menu (source `local`) stays until `rev` changes again (the
  newest change wins). `delay_sec` (0-120) and `relaunch_min` (0 = never, up to 1440) always apply.
  - At boot: `delay_sec` after start-up the box opens the app. The home screen shows a countdown, and any
    remote key cancels it.
  - Relaunch: when the home screen has been shown for `relaunch_min` minutes without a key press, the app
    opens again after the same countdown. A key press restarts the wait; the Secret Menu pauses it.
  - In the check-in the box reports what it uses now: `autostart { package, activity, source, rev }`.

## 2. Files

- `GET /api/box/wallpaper/<hash>` returns the image (`image/jpeg` or `image/png`), or 404 if it's no longer current.
- `GET /api/box/apk/<apk_id>` returns the APK (`application/vnd.android.package-archive`).
  The box checks `sha256` before installing.

## 3. Install on the box

1. Download to the app's own storage.
2. Check SHA-256.
3. Run `pm install -r -d <file>` as root (`su -c`).
4. If root fails, fall back to the Android package installer intent. The accessibility auto-allow service
   presses Install/Allow.
5. Report the result in the next check-in.

When the launcher replaces itself, Android restarts it as HOME.

## 4. eslink fallback (only when the CMS can't be reached)

The box needs a stored `property_id` (from an earlier check-in). Both calls are
`POST https://eslink.online/webservice.php`, `application/x-www-form-urlencoded`. The answer is a JSON
array: `[ { "type": "success"|"error", "for": "...", "info": ... } ]`.

1. Request `what_do_you_want=scodezy_authenticate_app&app_id=<id>&app_secret=<secret>`.
   The answer is `info.access_token`.
2. Request `what_do_you_want=eslink_custom_launcher_get_cms&property_id=<id>&xAwBo5Re9a=<access_token>`.
   The answer is `info.cms_host` and `info.cms_port`.

The box saves the new host and port, then retries the check-in once.

- Five wrong secrets lock the app on eslink for 4 hours, for every box, so the box never retries a
  refused secret in a loop.
- The app_id and secret come from the launcher build (`secrets.properties`, not in git).
