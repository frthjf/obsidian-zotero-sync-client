import { App, Plugin, PluginSettingTab, Setting, Notice, debounce, addIcon } from 'obsidian';
import { Sync as ZoteroAPI } from '@retorquere/zotero-sync'
import { Store } from '@retorquere/zotero-sync/json-store'
import { Zotero } from '@retorquere/zotero-sync/typings/zotero'
import path from 'path';
import fs from "fs";
import crypto from "crypto";

const md5 = (string: string) => {
	return crypto.createHash('md5').update(string).digest('hex');
}

interface ZoteroSyncClientSettings {
	api_key: string;
	sync_on_startup: boolean;
	show_ribbon_icon: boolean;
	sync_on_interval: boolean;
	sync_interval: number;
	note_generator: string;
	filepath_generator: string;
}

const DEFAULT_SETTINGS: ZoteroSyncClientSettings = {
	api_key: '',
	sync_on_startup: true,
	show_ribbon_icon: true,
	sync_interval: 0,
	note_generator: "return `# ${data.itemType}\n\n{${JSON.stringify(data)}}`",
	filepath_generator: "return `References/${data.key}.md`",
}

export default class MyPlugin extends Plugin {
	settings: ZoteroSyncClientSettings;
	store: Store;
	client: ZoteroAPI;
	last_sync: Date;
	interval: number;
	ribbonIconEl: HTMLElement | null;

	showError(exception: Error, kind: string) {
		new Notice(`[${kind}] ${exception.message}`)
		console.log(exception)
	}

	async onload() {
		addIcon("zotero", 
			`<svg version="1.0" xmlns="http://www.w3.org/2000/svg"  viewBox="0 0 948.000000 1580.000000" preserveAspectRatio="xMidYMid meet">
				<g transform="translate(0.00000,1280.000000) scale(0.075,-0.075)" fill="#888888" stroke="none">
					<path d="M1470 12796 c0 -2 -113 -492 -251 -1088 -137 -595 -299 -1296 -360 -1557 -60 -261 -109 -480 -109 -487 0 -12 411 -14 2573 -16 l2572 -3 -2947 -4688 -2948 -4688 0 -135 0 -134 5365 0 c2951 0 5365 2 5365 5 0 2 68 267 151 587 83 321 251 974 375 1452 l224 868 0 119 0 119 -2939 2 -2938 3 2938 4688 2939 4688 0 135 0 134 -5005 0 c-2753 0 -5005 -2 -5005 -4z"/>
				</g>
			</svg>`
	   );

		await this.loadSettings();
		this.addSettingTab(new ClientSettingTab(this.app, this));

		// initialize the store which acts as a cache
		this.store = new Store
		const storeDirectory = this.getPluginPath("store")
		if (!fs.existsSync(storeDirectory)) {
			fs.mkdirSync(storeDirectory);
		}
		await this.store.load(storeDirectory)

		// initialize the API client
		this.client = new ZoteroAPI
		this.client.on(ZoteroAPI.event.error, function() { console.log("ERROR!", [...arguments]) })
		for (const event of [ ZoteroAPI.event.library, ZoteroAPI.event.collection, ZoteroAPI.event.item ]) {
			this.client.on(event, (e => function() { console.log(e, [...arguments]) })(event))
		}

		// add commands
		this.addCommand({
			id: 'sync',
			name: 'Sync with Zotero',
			callback: () => {
				this.sync()
			}
		})

		this.updateRibbonBtn();

		this.apply_sync_interval()

		// authenticate
		try {
			await this.authenticate()
		} catch (e) {
			this.showError(e, "Zotero Authentication Failure")
			return
		}

		// sync on startup
		if (this.settings.sync_on_startup) {
			try {
				await this.sync()
			} catch (e) {
				this.showError(e, "Zotero Sync failure")
			}
		}
	}

	onunload() {

	}

	updateRibbonBtn() {
		if (this.ribbonIconEl) {
			this.ribbonIconEl.remove();
			this.ribbonIconEl = null;
		}
		if (this.settings.show_ribbon_icon) {
			this.ribbonIconEl = this.addRibbonIcon('zotero', 'Sync with Zotero', (evt: MouseEvent) => {
				this.sync()
			});
		}
	}

	getPluginPath(...append: string[]) {
		return path.join(
			this.app.vault.adapter.getBasePath(),
			this.app.vault.configDir,
			"plugins",
			"obsidian-zotero-sync-client",
			...append
		)
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async authenticate(key?: string) {
		if (!key) {
			key = this.settings.api_key
		}
		if (!/\S/.test(key)) {
			throw new Error("Please enter your Zotero API key");
		}

		try {
			await this.client.login(key)
		} catch (e) {
			throw new Error(e.message);
		}
	}

	apply_sync_interval() {
		if (this.interval) {
			window.clearInterval(this.interval)
		}

		if (this.settings.sync_interval > 0) {
			this.interval = window.setInterval(() => this.sync(), this.settings.sync_interval * 60 * 1000)
			this.registerInterval(this.interval)
		}
	}

	async sync(debounce_seconds: number = 0) {
		// check if sync has been completed recently
		if (this.last_sync && debounce_seconds > 0) {
			const now = new Date()
			const diff = now.getTime() - this.last_sync.getTime()
			// if it's been less than debounce time, don't sync
			if (diff < debounce_seconds * 1000) {
				return false
			}
		}

		if (false) { // note: you may want to disable the sync during
					//       development to avoid hitting API limits
			await this.syncWithZotero() 
		}

		for (const library of Object.values(this.client.libraries)) {
			await this.applyUpdates(library)
		}
		
		this.last_sync = new Date()
	}

	async syncWithZotero() {
		// retrieve latest updates from API and write to store
		await this.client.sync(this.store)
	}

	async applyUpdates(library: ZoteroAPI.RemoteLibrary) {
		const data = await this.readLibrary(library)
		const status = await this.readStatus(library)

		// compute changes
		const renames = {}
		const updates = {}
		const deletes = {}
		const creates = {}
		const updatedStatus = {
			items: {},
			collections: {}
		}

		for (const k of ['collections', 'items']) {
			for (const element of data[k].values()) {
				const filePath = this.generateNoteFilePath(element)
				try {
					this.app.vault.checkPath(filePath)
				} catch (e) {
					console.log("Invalid path: " + filePath)
					throw e
				}
				if (!filePath) {
					continue
				}
				const note = this.getMarker(element.key) + this.generateNote(element)
				const hash = md5(note)
				const key = element.key

				// check if note exists
				if (status[k][key]) {
					// does it need to be renamed?
					if (status[k][key].filePath != filePath) {
						// rename
						renames[key] = {from: status[k][key].filePath, to: filePath, note: note}
					}
					// does it need to be updated?
					if (status[k][key].hash !== hash) {
						// update
						updates[key] = {filePath: filePath, note: note}
					}

					// done
					delete status[k][key]
				} else {
					// create
					creates[key] = {filePath: filePath, note: note}
				}

				// add to updated status
				updatedStatus[k][key] = {
					filePath: filePath,
					hash: hash
				}
			}

			// delete remaining files
			for (const element of Object.values(status[k])) {
				deletes[element.key] = {filePath: element.filePath}
			}
		}

		// apply changes
		for (const [key, value] of Object.entries(renames)) {
			await this.renameFile(value.from, value.to, value.note)
		}
		for (const [key, value] of Object.entries(updates)) {
			await this.updateFile(value.filePath, value.note)
		}
		for (const [key, value] of Object.entries(deletes)) {
			await this.deleteFile(value.filePath)
		}
		for (const [key, value] of Object.entries(creates)) {
			await this.createFile(value.filePath, value.note)
		}
		
		// write status to store
		await this.writeStatus(library, updatedStatus)
	}

	aquireFile(filePath: string) {
		return this.app.vault.getAbstractFileByPath(filePath)
	}

	async renameFile(oldPath: string, newPath: string, note: string) {
		const fn = this.aquireFile(oldPath)
		if (!fn) {
			await this.createFile(newPath, note)
		} else {
			await this.app.vault.rename(fn, newPath)
		}
		
	}

	async updateFile(filePath: string, note: string) {
		const fn = this.aquireFile(filePath)
		if (!fn) {
			await this.createFile(filePath, note)
		} else {
			await this.app.vault.modify(fn, note)
		}
	}

	async createFile(filePath: string, note: string) {
		const fn = this.aquireFile(filePath)
		if (fn) {
			await this.app.vault.modify(fn, note)
		} else {
			fs.mkdir(path.join(this.app.vault.adapter.getBasePath(), path.dirname(filePath)), {recursive: true}, (err) => {
				if (err) throw err;
			});
			await this.app.vault.create(filePath, note)
		}
	}

	async deleteFile(filePath: string) {
		const fn = this.aquireFile(filePath)
		if (!fn) {
			return
		}
		await this.app.vault.delete(filePath)
	}

	generateNoteFilePath(data) : string {
		const parse = new Function('data', this.settings.filepath_generator)
		return parse(data)
	}

	generateNote(data) : string {
		const parse = new Function('data', this.settings.note_generator)
		return parse(data)
	}

	getMarker(key: string) {
		return `\n<!-- zotero_key: ${key} -->\n\n`
	}
	
	async readLibrary(library: ZoteroAPI.RemoteLibrary) {
		// read library data from store and organize into a map
		try {
			const data = JSON.parse(await fs.promises.readFile(this.getPluginPath("store", `${encodeURIComponent(library.prefix)}.json`), 'utf-8'))
			let map = {
				collections: new Map(data.collections.map((c: Zotero.Collection["data"]) => [c.key, c])),
				items: new Map(data.items.map((i: Zotero.Item.Any) => [i.key, i]))
			}
			// rewrite any collection with parentCollection key to be nested in its parent
			for (const [key, collection] of map.collections) {
				if (!collection.itemType) {
					collection.itemType = "collection"
				}
				if (!collection.children) {
					collection.children = []
				}
				if (collection.parentCollection) {
					const parent = map.collections.get(collection.parentCollection)
					if (!parent) {
						continue
					}
					if (!parent.children) {
						parent.children = []
					}
					parent.children.push(collection)
				}
			}
			// rewrite any item with parentItem key to be nested in its parent
			for (const [key, item] of map.items) {
				if (!item.children) {
					item.children = []
				}
				if (item.parentItem) {
					const parent = map.items.get(item.parentItem)
					if (!parent) {
						continue
					}
					if (!parent.children) {
						parent.children = []
					}
					parent.children.push(item)
					map.items.delete(key)
				}
			}
			
			return map
		} catch (e) {
			throw new Error("Unable to read library data: " + e.message);
		}
	}

	async readStatus(library: ZoteroAPI.RemoteLibrary) {
		// read library status from store
		try {
			return JSON.parse(await fs.promises.readFile(this.getPluginPath("store", `${encodeURIComponent(library.prefix)}.status.json`), 'utf-8'))
		} catch (e) {
			return {
				collections: new Map(),
				items: new Map()
			};
		}
	}

	async writeStatus(library: ZoteroAPI.RemoteLibrary, status: any) {
		// write library status to store
		try {
			await fs.promises.writeFile(this.getPluginPath("store", `${encodeURIComponent(library.prefix)}.status.json`), JSON.stringify(status))
		} catch (e) {
			throw new Error("Unable to write library status: " + e.message);
		}
	}

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
				.onChange(debounce(async (value) => {
					try {
						await this.plugin.authenticate(value);
						this.plugin.settings.api_key = value;
						await this.plugin.saveSettings();
					} catch (e) {
						this.plugin.showError(e, "Failed to authenticate with Zotero")
					}
				}, 500)));

		containerEl.createEl('h2', {text: 'Syncing'});

		new Setting(containerEl)
			.setName('Sync on startup')
			.setDesc('Sync Zotero library on Obsidian startup')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.sync_on_startup)
				.onChange(async (value) => {
					this.plugin.settings.sync_on_startup = value;
					await this.plugin.saveSettings();
				}
			));

		new Setting(containerEl)
			.setName('Sync interval')
			.setDesc('Sync interval in minutes (leave blank to disable)')
			.addText(text => text
				.setPlaceholder('Sync interval in minutes')
				.setValue(this.plugin.settings.sync_interval ? this.plugin.settings.sync_interval.toString() : '')
				.onChange(async (value: string) => {
					this.plugin.settings.sync_interval = isNaN(parseInt(value)) ? 0 : parseInt(value);
					await this.plugin.saveSettings();
					this.plugin.apply_sync_interval();
				}
			));

		new Setting(containerEl)
			.setName('Show sync ribbon button')
			.setDesc('Offer a button in the ribbon menu to manually sync the library')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.show_ribbon_icon)
				.onChange(async (value) => {
					this.plugin.settings.show_ribbon_icon = value;
					this.plugin.updateRibbonBtn();
					await this.plugin.saveSettings();
				}
			));


		containerEl.createEl('h2', {text: 'Note generation'});

		containerEl.createEl("span", {text: "Use the command palette to edit note generation templates."});

	}
}
