# Forever Profile Porter

<img src="build/icon.png" alt="" width="96" align="right">

Get your WoW Forever character's whole setup onto a new character in one go: addons and their settings, keybinds, macros, game options like auto loot and camera distance, chat windows and frame positions.

Take a **snapshot** of a WoW Forever Beta character once its setup is the way you like it, then **apply** it to your new character on launch day by typing the new first and last name and picking the ruleset. It doesn't just copy the `WTF` and `Interface\AddOns` folders: it opens every addon's saved data and rewrites each place the old character's name, ruleset, realm and GUID appear, so every addon finds its profile under the new character.

## Download

Get the latest version from **[Releases](https://github.com/Pat1entZ3r0/wowsettingsporter/releases/latest)**:

- **`ForeverProfilePorter-<version>-Portable.exe`** runs straight away with nothing to install.
- **`ForeverProfilePorter-<version>-Setup.exe`** installs it with Start menu and desktop shortcuts.

Both are the same app for 64-bit Windows 10 and 11. The exe isn't code-signed, so Windows SmartScreen may warn the first time you run it: click **More info**, then **Run anyway**.

## Using it

1. **Game folders.** The beta (`World of Warcraft\_classic_beta_`) and live game folders are found automatically from the registry and the usual install locations. Use **Browse…** if yours is somewhere else (pick either the `World of Warcraft` folder or the game folder inside it).
2. **Snapshots.** Pick the beta account and character, check the first and last name, choose what to include and press **Take snapshot**. The snapshot is a full copy, so it keeps working after the beta client is gone. Snapshots can be exported to a `.ffpsnap` file and imported on another PC.
3. **Apply to a character.** On live, create the new character, **log in once and exit** (so WoW creates its folders), then type the new first and last name and pick the ruleset. The app finds the character's folder, shows a preview of every file and every replacement, and applies it after backing up everything it touches.
   To try a snapshot out before launch, set **Game to apply to** to the beta and pick another beta character from the list.
4. **Backups.** Each apply can be undone from the Backups page. A full copy of the live `WTF` folder from just before the apply is kept next to it too.

Exit World of Warcraft before applying: the game rewrites these files when you log out.

Nothing is changed until you press **Apply**, and every apply is backed up first. Snapshots and backups are kept in `%APPDATA%\Forever Profile Porter\`.

## What gets rewritten

On WoW Forever characters have a first and last name and realms are replaced by rulesets. The AceDB library the addons share (r39 and later) keys a character as `"First Surname"` and uses the ruleset as its realm: `PvE` (Normal), `PvP`, `RP` (Roleplaying) or `Hardcore`. So a snapshot of Alice Smith on Normal applied to Carol Hale on PvP changes, inside every SavedVariables file:

| In the beta data | Becomes |
|---|---|
| `["Alice Smith"]` (profile keys, per-character data, profile names) | `["Carol Hale"]` |
| `["Alliance - PvE"]`, `["Alliance - PvE - US"]` (faction-ruleset data) | `["Alliance - PvP"]`, `["Alliance - PvP - US"]` |
| `realm = { ["PvE"] = … }` (AceDB realm section only) | `realm = { ["PvP"] = … }` |
| `"Alice - <realm name>"`, `"Alice Smith-<realm>"` (addons on an older AceDB, or Name-Realm keys) | the same with the new name and live realm name, once that's known |
| `Player-70-0A1B2C3D` (the character's GUID) | the new character's GUID, once that's known |
| `"Alice"` as a whole string | `"Carol"` (can be turned off) |

Matching is on whole words, so `Alice Smithers` or a realm `701` are never touched, and a ruleset name is only renamed as an AceDB realm key, never inside ordinary text. Entries keyed by the beta account's *other* characters are left out, so they don't show up on live.

The files are parsed with a real Lua table parser (strings are kept byte for byte, so serialized addon data survives), rewritten, and written back in the same format the game writes. Account-wide addon data is **merged** into what's already on live by default, so your other live characters keep their settings; it can replace instead.

Per-character files (`AddOns.txt`, `macros-cache.txt`, `bindings-cache.wtf`, `config-cache.wtf`, `layout-local.txt`, `chat-cache.txt` and per-character SavedVariables) go into the new character's folder, with the name replaced in the text files too.

Game options are copied setting by setting, and the preview lists every one that changes: the client's `Config.wtf` (camera distance, graphics, sound; install and login values like the portal and account name are never copied), the account's `config-cache.wtf` (auto loot, interface and combat options) and the character's `config-cache.wtf`. Options only the target has are kept.

Two optional switches in `Config.wtf`, both on by default:

- **Stop server sync replacing the ported keybinds and macros** sets `synchronizeSettings`, `synchronizeConfig`, `synchronizeBindings`, `synchronizeMacros` and `synchronizeChatFrames` to `0`, so the copies on Blizzard's servers don't overwrite the ported ones at login. Turn sync back on in game later if you want it.
- **Load out-of-date addons** sets `checkAddonVersion` to `0`, in case the live client's interface number is newer than the beta addons' TOCs.

## Things it can't do

- **Action bar placements** (which spell is on which button) are stored on Blizzard's servers, not in any file.
- **Edit Mode layouts** are server-side too, so paste each layout's export string into its snapshot (Snapshots page, Add a layout). The Apply page then has a Copy button for each, ready to import on the new character.
- The live client's folder name and what `GetRealmName()` returns on live weren't public when this was written. The app finds them from the live install once the new character has logged in once; until then they can be typed in under **Folders and identity details**.
- Addons that store data in their own formats (compressed or encoded strings) keep the old name inside those strings. Most store settings per profile, which is handled.

## Building

Needs Node.js 20+.

```
npm install
npm test              # core tests (uses lua5.1 if installed to check the written files load in real Lua)
npm run test:ui       # drives the whole UI in Chromium against a fake install (needs playwright-core's Chromium)
npm run test:electron # the same flow in the real Electron app (Linux: needs xvfb-run)
npm start             # run the app
npm run dist:win      # dist\ForeverProfilePorter-<version>-Setup.exe and dist\ForeverProfilePorter-<version>-Portable.exe
```

Releases are built by the GitHub Actions workflow in `.github/workflows/release.yml` whenever a `v*` tag is pushed (or when it's run by hand). To build yourself, Windows needs no extra tools. On Linux, electron-builder's NSIS step needs Wine with 32-bit support (`wine` and `wine32:i386`). `build/after-pack.js` sets the exe's icon and version info with `resedit` rather than rcedit.

## Layout

```
src/core/lua.js        SavedVariables parser, writer and merge
src/core/identity.js   identities, rewrite rules, detection of how a character appears in addon data
src/core/wow.js        finding installs, accounts, characters and addons
src/core/snapshot.js   taking, listing, exporting and importing snapshots
src/core/apply.js      planning, backing up, applying and restoring
src/main/              Electron main process, IPC handlers and preload
src/renderer/          the UI
test/                  fixtures, core tests, UI harness and end-to-end test
```

## License

MIT. See [LICENSE](LICENSE).
