# Obsidian Zotero Sync Client

This plugin leverages the Zotero Sync API to mirror your Zotero library as markdown files within Obsidian.

Zotero does not have to be installed since the data is directly obtained from Zotero's web API - all you need is an [Zotero API key](https://www.zotero.org/settings/keys/new) and internet connection when syncing.

Note that, by design, the synchronization is *read-only* and does not modify your Zotero library. Any changes to the markdown files will be lost and *not* synced back into Zotero. The rationale is to enable seamless Zotero integration via note linking and search while keeping all literature data within Zotero.

### Alternatives

This plugin is for you if you are interested in linking to and searching through a read-only version of your Zotero library within Obsidian. Check out the following alternatives if you are interested in:

- Taking notes directly within Zotero (with two-way sync to Obsidian): [Zotero Better Notes](https://github.com/windingwind/zotero-better-notes)
- Importing citations on-demand into Obsidian: [Obsidian Zotero Integration](https://github.com/mgmeyers/obsidian-zotero-integration) or [Obsidian Citation Plugin](https://github.com/hans/obsidian-citation-plugin)
- Integrating with Zotero via the ZotServer API: [Zotero Bridge](https://github.com/vanakat/zotero-bridge)
- [Suggest other alternatives](https://github.com/frthjf/obsidian-zotero-sync-client/issues) ...


## Usage

Install the plugin and enable it in the settings. Generate a [Zotero API key](https://www.zotero.org/settings/keys/new) and fill it in the plugin settings.

The plugin will sync and cache all Zotero data incremently to minimize API usage.

After initial synchronization (which may take a while), all Zotero notes should appear in the configured vault folder.

### Mobile devices

While this plugin is only available on desktop, any generated Zotero markdown files will be synced to connected mobile clients just like any other file.

### Custom templates

By default, the markdown files are generated using a standard template which can be previewed and modified in the settings, giving you full control over the file generation.

https://github.com/frthjf/obsidian-zotero-sync-client/assets/5411942/81a58562-af7a-4d74-a1c8-459dc78e116f

