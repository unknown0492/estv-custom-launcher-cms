# estv-custom-launcher-cms

This is the hotel's CMS for the **esTV Custom Launcher** boxes (`com.excel.estvlauncher.custom`). It runs on a
Windows PC on the hotel LAN, in PM2, and starts with Windows. It listens on port **4053**.

- **Boxes:** each box checks in every 5 minutes with its MAC, IP, name and versions. It pulls the wallpaper,
  the home buttons and any APK updates in the same call. The contract is in `docs/box-protocol.md`.
- **Web page:** sign in with an eslink account. The first sign-in on a new CMS chooses the hotel's property.
  - Boxes: every box with its MAC, IP, last check-in, launcher and button-app versions, and update state.
    You can search, sort and export to CSV.
  - Wallpaper: the background of the launcher's home screen.
  - Home buttons: name, package and start activity of each button after Menu.
  - APK updates: upload an APK of the launcher or a button app. Boxes install the newest active APK per app,
    and the page shows each box's progress. "Install via ADB" is a backup.
  - Settings: the property, this PC's address for the boxes, and the path to adb.exe.
- **eslink:** the CMS keeps no eslink secret. Sign-in uses the person's own eslink account, through
  `scodezy_login`, `eslink_custom_launcher_cms_properties` and `eslink_custom_launcher_cms_sign_in`. A box that
  can't reach this PC asks eslink for its address (Other Products > Custom Launcher > CMS IP).

## Install / update on the CMS PC

In a normal cmd window:

```
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol='Tls12'; irm https://files.estv.cloud/estv-custom-launcher-cms/installer/install.ps1 | iex"
```

It downloads `installer\` (install-cms.bat and its helpers) and runs install-cms.bat as Administrator, which:

1. installs Git and Node.js LTS if they're missing;
2. installs the CMS from GitHub `main` into `<drive>:\estv-custom-launcher-cms` (or updates it there);
3. sets up PM2 and its start with Windows;
4. adds the firewall rule for TCP 4053 and the Desktop shortcuts;
5. opens the web page.

Running it again updates the CMS and keeps `data\` (database, wallpaper, APKs, property).

## Development

```
npm install
set CMS_PORT=4153& set ESLINK_API_URL=http://localhost/eslink/& node server.js
npm test                      (set CMS_TEST_APK=<some .apk> to include the APK checks)
```

| Path | What |
|---|---|
| `server.js` | Express app |
| `routes/boxApi.js` | `/api/box/*`: check-in, wallpaper, APK download |
| `routes/adminApi.js` | `/admin/api/*`: web page API (needs a session) |
| `modules/` | db (better-sqlite3, `data\cms.db`), auth (sessions, lock-out), eslink, apk (manifest reader), adb, logger |
| `public/` | web page (Bootstrap 5 + jQuery from node_modules, no internet needed) |
| `installer/` | install.ps1, install-cms.bat, CMS-PM2-Init.bat, Ensure-Tool.ps1, Read-GitHubToken.ps1 |
| `windows/` | Desktop shortcut targets |
