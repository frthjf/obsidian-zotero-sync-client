import { App, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { Sync as ZoteroClient } from '@retorquere/zotero-sync'
import { Store } from '@retorquere/zotero-sync/json-store'
import { Zotero } from '@retorquere/zotero-sync/typings/zotero'
import path from 'path';


interface ZoteroSyncClientSettings {
	api_key: string;
}

const DEFAULT_SETTINGS: ZoteroSyncClientSettings = {
	api_key: ''
}

export default class MyPlugin extends Plugin {
	settings: ZoteroSyncClientSettings;

	async onload() {
		await this.loadSettings();

		this.addSettingTab(new ClientSettingTab(this.app, this));

		this.zoteroSync();
	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async zoteroSync() {
		const zotero = new ZoteroClient()
	  
		// will emit the following so you can track progress:
		// emit(Sync.event.library, <library object>, n, total number of libraries). Called at the start of a library sync. Library name is empty for the main library, if there's a name, it's a group library
		// emit(Sync.event.error, err)
		// emit(Sync.event.item, <item object>, n, total number of items within library). Called when an item is added/updated
		// emit(Sync.event.collection, <collection object>, n, number of collections within library). Called when a collection is added/updated
	  
		for (const event of [ ZoteroClient.event.library, ZoteroClient.event.collection, ZoteroClient.event.item, ZoteroClient.event.error ]) {
		  zotero.on(event, (e => function() { console.log(e, [...arguments]) })(event))
		}
		await zotero.login(this.settings.api_key)
		const folder = "References"
		if (!this.app.vault.getAbstractFileByPath(folder)) {
			await this.app.vault.createFolder(folder)
		}

		const directory = path.join(this.app.vault.adapter.basePath, folder)
		await zotero.sync(await (new Store).load(directory))
	}

	async parseItem(item: Zotero.Item.Any) {
		// translates a Zotero data item into a note
	}

	// 
}

class ClientSettingTab extends PluginSettingTab {
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		containerEl.createEl('h2', {text: 'Zotero API'});

		new Setting(containerEl)
			.setName('API key')
			.setDesc('Zotero API key for read-only access')
			.addText(text => text
				.setPlaceholder('Enter your secret API key')
				.setValue(this.plugin.settings.api_key)
				.onChange(async (value) => {
					// console.log('API key changed: ' + value);
					this.plugin.settings.api_key = value;
					await this.plugin.saveSettings();
				}));
	}
}
