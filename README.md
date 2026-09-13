# pi-web-jj — Jujutsu workspaces for PI WEB

A standalone [PI WEB plugin](https://pi-web.dev/plugins) that makes [Jujutsu](https://jj-vcs.dev) (`jj`) repositories first-class PI WEB workspaces, as an alternative to the bundled Git provider.

Browser entry: PI WEB plugin API **v2**. Server entry: PI WEB server-plugin API **v1**. Both import only `@jmfederico/pi-web/plugin-api` and `@jmfederico/pi-web/server-plugin-api` (type-only).

## What it does

- **Claims** any registered project whose path resolves through `jj root` as a primary workspace provider — Jujutsu wins over the bundled fallback Git provider.
- **Lists workspaces**: every `jj workspace list` entry becomes a PI WEB workspace, labelled by workspace name (`default`, or the name you passed to `jj workspace add`).
- **Jujutsu panel** (in place of the Git panel for jj-owned workspaces): working-copy change id/description, changed-file list, and the unified diff of the selected file with inline word highlighting. Polls every 15 s.
- **Workspace deletion** for linked workspaces only: `jj workspace forget '<name>' && rm -rf '<path>'`, run by the host in a visible terminal after confirmation.

### Colocated repositories

Jujutsu colocates a Git repository by default, so most Jujutsu workspaces are also Git working trees. This plugin claims them by default. To hand colocated projects back to Git while keeping Jujutsu for non-colocated repositories and linked workspaces (which Git cannot see):

```json
{
  "plugins": {
    "jj": { "enabled": true, "settings": { "claimColocated": false } }
  }
}
```

Safety rules for removal, always enforced:

- never the registered/main workspace, never a workspace named `default`;
- never a workspace whose `.jj/repo` is a directory — that directory *is* the repository store;
- re-validated against live `jj workspace list` at removal time; a failed `forget` never deletes files.

## Install

Requires PI WEB `1.202608.1` or newer and `jj` on the session daemon's `PATH`.

```bash
npm install
npm run build
mkdir -p ~/.pi-web/plugins
ln -s "$PWD" ~/.pi-web/plugins/jj
```

If `PI_WEB_DATA_DIR` is set, link into `$PI_WEB_DATA_DIR/plugins` instead. The link name must be a valid plugin id (`jj`).

Then, because this plugin has a server entry:

```bash
systemctl --user restart pi-web-sessiond
```

and reload the browser tab (hard reload after plugin updates — module URLs carry a content revision). Restarting sessiond may interrupt active sessions.

## Debug

- **Manifest**: `curl http://127.0.0.1:8504/pi-web-plugins/manifest.json` — the `jj` entry must list `dist/browser/pi-web-plugin.js`; `backendRevision` appears once the server entry is active.
- **Module asset**: `curl -I http://127.0.0.1:8504/pi-web-plugins/jj/dist/browser/pi-web-plugin.js` must return 200 with a JavaScript content type.
- **Settings → PI WEB plugins** shows desired vs. active state, including restart-required and health.
- **Browser console**: plugin failures surface as console errors with the module URL; a stale cached module after an edit needs a hard reload.
- **Session daemon log**: `journalctl --user -u pi-web-sessiond` shows activation/health records for `jj`.

## Development

```bash
npm install
npm test        # vitest; jj fixture tests are skipped when `jj` is not installed
npm run build   # tsc -> dist/server-plugin.js + dist/browser/
```

`src/browser/` compiles to the browser-served `dist/browser/`; the server module compiles to `dist/server-plugin.js`, deliberately outside the browser root — only files under `browserRoot` are served to the browser.
