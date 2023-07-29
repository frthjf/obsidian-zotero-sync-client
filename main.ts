import { App, Plugin, PluginSettingTab, Setting, Notice, debounce, addIcon, prepareFuzzySearch } from 'obsidian';
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
	note_generator: `let n = '# ' + data.title + '\\n\\n';
if (data.date) {
	n += data.date + '\\n';
}

if (data.creators) {
	n += '\\n';
	data.creators.forEach(author => {
		n += '[[People/' + author.firstName + ' ' + author.lastName + ']] ';
	});
}

n += '\\n\\n[Open in Zotero](zotero://select/library/items/' + data.key + ')\\n\\n';

return n;`,

	filepath_generator: `let fp = '';
if (data.creators && data.creators.length > 0) {
fp += data.creators[0]?.lastName;
if (data.creators.length == 2) {
	fp += '+';
	fp += data.creators[1]?.lastName;
} else if (data.creators.length > 2) {
	fp += '+';
}
if (data.date) {
	let year = new Date(data.date).getFullYear();
	fp += year.toString();
}
return 'References/' + fp;
}`,
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

		this.applySyncInterval()

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

	applySyncInterval() {
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

		if (true) { // note: you may want to disable the sync during
					//       development to avoid hitting API limits
			await this.syncWithZotero() 
		}

		this.applyAllUpdates()
		
		this.last_sync = new Date()
	}

	async syncWithZotero() {
		// retrieve latest updates from API and write to store
		await this.client.sync(this.store)
	}

	async applyAllUpdates() {
		for (const library of Object.values(this.client.libraries)) {
			await this.applyUpdates(library)
		}
	}

	async applyUpdates(library: ZoteroAPI.RemoteLibrary) {
		const data = await this.readLibrary(library.prefix)
		const status = await this.readStatus(library.prefix)

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
			try {
				await this.renameFile(value.from, value.to, value.note)
			} catch (e) {
				console.log("Failed to rename file: " + value.from + " -> " + value.to + " (" + e.message + ")");
			}
		}
		for (const [key, value] of Object.entries(updates)) {
			try {
				await this.updateFile(value.filePath, value.note)
			} catch (e) {
				console.log("Failed to update file: " + value.filePath + " (" + e.message + ")");
			}
		}
		for (const [key, value] of Object.entries(deletes)) {
			try {
				await this.deleteFile(value.filePath)
			} catch (e) {
				console.log("Failed to delete file: " + value.filePath + " (" + e.message + ")");
			}
		}
		for (const [key, value] of Object.entries(creates)) {
			try {
				await this.createFile(value.filePath, value.note)
			} catch (e) {
				console.log("Failed to create file: " + value.filePath + " (" + e.message + ")");
			}
		}
		
		// write status to store
		await this.writeStatus(library.prefix, updatedStatus)
	}

	aquireFile(filePath: string) {
		// todo: check if file has been generated by this plugin
		return this.app.vault.getAbstractFileByPath(filePath)
	}

	async renameFile(oldPath: string, newPath: string, note: string) {
		const fn = this.aquireFile(oldPath)
		if (!fn) {
			await this.createFile(newPath, note)
		} else {
			fs.mkdir(path.join(this.app.vault.adapter.getBasePath(), path.dirname(newPath)), {recursive: true}, (err) => {
				if (err) throw err;
			});
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

	generateNoteFilePath(data, template = null) : string {
		if (!template) {
			template = this.settings.filepath_generator
		}
		const parse = new Function('data', template)
		const result = parse(data)
		if (result) {
			if (result.endsWith('.md')) {
				return result
			}
			return result + '.md'
		} else {
			return ""
		}
	}

	generateNote(data, template = null) : string {
		if (!template) {
			template = this.settings.note_generator
		}
		const parse = new Function('data', template)
		return parse(data)
	}

	getMarker(key: string) {
		return `<!-- zotero_key: ${key} -->\n\n`
	}
	
	async readLibrary(library: string) {
		// read library data from store and organize into a map
		try {
			const data = JSON.parse(await fs.promises.readFile(this.getPluginPath("store", `${encodeURIComponent(library)}.json`), 'utf-8'))
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

	async readStatus(library: string) {
		// read library status from store
		try {
			return JSON.parse(await fs.promises.readFile(this.getPluginPath("store", `${encodeURIComponent(library)}.status.json`), 'utf-8'))
		} catch (e) {
			return {
				collections: new Map(),
				items: new Map()
			};
		}
	}

	async writeStatus(library: string, status: any) {
		// write library status to store
		try {
			await fs.promises.writeFile(this.getPluginPath("store", `${encodeURIComponent(library)}.status.json`), JSON.stringify(status))
		} catch (e) {
			throw new Error("Unable to write library status: " + e.message);
		}
	}

	async clearStatus(library: string) {
		// clear library status from store
		try {
			await fs.promises.unlink(this.getPluginPath("store", `${encodeURIComponent(library)}.status.json`))
		} catch (e) {
			throw new Error("Unable to clear library status: " + e.message);
		}
	}

	async clearCache() {
		for (const library of Object.values(this.client.libraries)) {
			await this.clearStatus(library.prefix)
		}
		new Notice(`Cleared cache`)
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
						this.display();
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
					this.plugin.applySyncInterval();
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

		new Setting(containerEl)
			.setName('Caching')
			.setDesc(
				'Note files are cached to improve performance; if you make changes to the note files outside of Obsidian, you can use this button to clear the cache.'
			)
			.addButton(button => button
				.setButtonText('Clear cache')
				.onClick(async () => {
					this.plugin.clearCache();
				})
			);

		if (this.plugin.client.libraries) {

		const fpCodeEditor = document.createElement('textarea');
		const ntCodeEditor = document.createElement('textarea');

		new Setting(containerEl)
			.setName('Note generation')
			.setDesc(
				'The JavaScript code in the left column below is used to generate the notes from items in your Zotero library.' +
				' You can preview code changes by selecting a file from the preview list. ' +
				' Once you are done, you can apply the changes to your vault by clicking the "Apply" button. '
			)
			.addButton(button => button
				.setButtonText('Apply')
				.onClick(async () => {
					// save settings
					this.plugin.settings.filepath_generator = fpCodeEditor.value
					this.plugin.settings.note_generator = ntCodeEditor.value
					await this.plugin.saveSettings();
					// apply changes
					this.plugin.applyAllUpdates();
					new Notice('Applied changes');
				})
			);

		// Filepath generation elements

		const librarySelect = document.createElement('select');
		librarySelect.style.display = 'flex';
		librarySelect.style.flexDirection = 'row';
		let libraryCount = 0;
		for (const library of Object.values(this.plugin.client.libraries)) {
			const option = document.createElement('option');
			option.value = library.prefix;
			option.text = library.prefix;
			librarySelect.appendChild(option);
			libraryCount++;
		}
		
		const fpMsg = document.createElement("div");
		fpMsg.innerText = 'Use `data` to access the Zotero item data and return a relative filepath. '
					+ 'You may return an empty string to skip note generation for the item. ';
		fpMsg.style.padding = '5px';
		fpMsg.style.fontSize = '10pt';


		fpCodeEditor.value = this.plugin.settings.filepath_generator;

		const filterInput = document.createElement('input');
		filterInput.type = 'text';
		filterInput.placeholder = 'Filter files';
	
		const fileSelect = document.createElement('select');
		fileSelect.multiple = true;
		fileSelect.style.border =  'none';

		const filter = debounce(() => {
			const filterValue = filterInput.value.toLowerCase();
			const predicate = prepareFuzzySearch(filterValue);
			for (let i = 0; i < fileSelect.options.length; i++) {
			  const option = fileSelect.options[i];
			  // option.style.display = option.text.toLowerCase().includes(filterValue) ? '' : 'none';
			  option.style.display = predicate(option.text.toLowerCase()) ? '' : 'none';
			}
		}, 100);
		filterInput.addEventListener('input', filter);


		// Note generation elements

		const ntMsg = document.createElement("div");
		ntMsg.style.padding = '5px';
		ntMsg.style.fontSize = '10pt';
		ntMsg.innerText = 'Use `data` to access the Zotero item data and return the note content';

		ntCodeEditor.value = this.plugin.settings.note_generator;

		const ntPreviewToggle = document.createElement('select');
		const options = {
			// md_prev: 'View markdown preview', 
			md: 'View generated markdown source', 
			json: 'View JSON data'
		}
		Object.entries(options).forEach(([value, name]) => {
			const option = document.createElement('option');
			option.value = value;
			option.text = name;
			ntPreviewToggle.appendChild(option);
		});
		
		const ntPreview = document.createElement('pre');
		ntPreview.style.fontSize = '9pt';
		ntPreview.style.overflow = 'auto';
		ntPreview.style.padding = '3px';
		ntPreview.innerText = '';

		// Refresh preview logic
		const refreshPreview = async () => {
			const library = librarySelect.value;
			const data = await this.plugin.readLibrary(library);

			// parse file names
			let fileNames = [];
			for (const item of data.items.values()) {
				try {
					const fp = this.plugin.generateNoteFilePath(item, fpCodeEditor.value);
					if (fp) {
						fileNames.push({
							name: fp,
							value: item.key
						});
					}
					fpCodeEditor.style.borderColor = '';
				} catch (e) {
					// display full error in preview
					ntPreview.innerText = e;
					fpCodeEditor.style.borderColor = 'red';
					return;
				}
			}

			// update file select
			const activeSelection = fileSelect.selectedOptions[0]?.value;
			fileSelect.innerHTML = '';
			fileNames.forEach(({name, value}) => {
				const option = document.createElement('option');
				option.value = value;
				option.text = name;
				fileSelect.appendChild(option);
			});
			// restore active selection
			if (activeSelection) {
				fileSelect.value = activeSelection;
			}
			// if none selected, select first item
			if (!fileSelect.value && fileSelect.options.length > 0) {
				fileSelect.value = fileSelect.options[0].value;
			}

			if (fileSelect.options.length === 0) {
				ntPreview.innerText = 'No files to preview';
				return;
			}

			// update preview
			const element = data.items.get(fileSelect.value);
			const previewType = ntPreviewToggle.value;
			if (previewType === 'md') {
				try {
					ntPreview.innerText = this.plugin.generateNote(element, ntCodeEditor.value);
					ntCodeEditor.style.borderColor = '';
				} catch (e) {
					// display full error in preview
					ntPreview.innerText = e;
					ntCodeEditor.style.borderColor = 'red';
					return;
				}
			} else if (previewType === 'md_prev') {
				// todo: add markdown preview
			} else if (previewType === 'json') {
				ntPreview.innerText = JSON.stringify(element, null, 2);
			}

		}

		// Refresh preview on change
		librarySelect.addEventListener('change', refreshPreview);
		fileSelect.addEventListener('change', refreshPreview);
		ntPreviewToggle.addEventListener('change', refreshPreview);
		fpCodeEditor.addEventListener('input', debounce(refreshPreview, 1000));
		ntCodeEditor.addEventListener('input', debounce(refreshPreview, 1000));

		
		// Form grid layout
		const table = containerEl.createEl("table");
		table.style.width = "100%";
		table.style.height = "100%";
		table.style.marginTop = "10px";
		table.style.tableLayout = "fixed";
		for (let i = 0; i < 2; i++) {
			const row = document.createElement("tr");
			for (let j = 0; j < 2; j++) {
				const cell = document.createElement("td");
				cell.style.verticalAlign = "top";

				const formContainer = document.createElement("div");
				formContainer.style.display = "flex";
				formContainer.style.flexDirection = "column";
				formContainer.style.height = "100%";

				if (i === 0 && j === 0) {
					formContainer.appendChild(fpMsg);
					formContainer.appendChild(fpCodeEditor);
					fpCodeEditor.style.width = "100%";
					fpCodeEditor.style.minHeight = "200px";
					fpCodeEditor.style.flexGrow = "1";
				} else if (i === 0 && j === 1) {
					if (libraryCount > 1) {
						formContainer.appendChild(librarySelect);
					}
					formContainer.appendChild(filterInput);
					filterInput.style.width = "100%";
					formContainer.appendChild(fileSelect);
					fileSelect.style.width = "100%";
					fileSelect.style.flexGrow = "1";
				} else if (i === 1 && j === 0) {
					formContainer.appendChild(ntMsg);
					formContainer.appendChild(ntCodeEditor);
					ntCodeEditor.style.width = "100%";
					ntCodeEditor.style.minHeight = "200px";
					ntCodeEditor.style.flexGrow = "1";
				} else if (i === 1 && j === 1) {
					formContainer.appendChild(ntPreviewToggle);
					formContainer.appendChild(ntPreview);
					ntPreview.style.width = "100%";
					ntPreview.style.minHeight = "200px";
				}

				cell.appendChild(formContainer);
				row.appendChild(cell);
			}
			table.appendChild(row);
		}

		refreshPreview();

		} // end of connected-only settings
	}
}
