import type { PiWebPlugin } from "@jmfederico/pi-web/plugin-api";
import { createJjBrowserContributions } from "./jj-panel.js";

const plugin: PiWebPlugin = {
  apiVersion: 2,
  name: "Jujutsu",
  activate: ({ pluginId, runtimePluginId, html, svg }) => ({
    contributions: createJjBrowserContributions(pluginId, runtimePluginId, html, svg),
  }),
};

export default plugin;
