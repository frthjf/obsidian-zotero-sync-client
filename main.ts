import { 
	App, 
	Plugin, 
	PluginSettingTab, 
	Setting, 
	TFile, 
	FileSystemAdapter, 
	htmlToMarkdown, 
	normalizePath, 
	Notice, 
	debounce, 
	addIcon, 
	prepareFuzzySearch, 
	TAbstractFile 
} from 'obsidian';
import { Sync as ZoteroAPI } from '@retorquere/zotero-sync/index'
import { Store } from '@retorquere/zotero-sync/json-store'
import { Zotero } from '@retorquere/zotero-sync/typings/zotero'
import path from 'path';
import fs from "fs";
import crypto from "crypto";

const md5 = (string: string) : string => {
	return crypto.createHash('md5').update(string).digest('hex');
}

type ZoteroCollectionItem = Zotero.Collection["data"] & {
	itemType: "collection";
	children: ZoteroCollectionItem[];
};

interface ZoteroNoteItem extends Zotero.Item.Note {
	note_markdown: string;
}

type ZoteroItem = Zotero.Item.Any & ZoteroNoteItem & {
	children: ZoteroItem[];
	parentItem: string;
};

type ZoteroNoteStatus = {
	filePath: string;
	hash: string;
}

type ZoteroRemoteLibrary = {
    type: 'group' | 'user';
    prefix: string;
    name: string;
    version?: number;
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
	sync_on_interval: false,
	sync_interval: 0,
	note_generator: `let n = '';
if (data.creators) {
	data.creators.forEach(author => {
	n += '[[People/' + author.firstName + ' ' + author.lastName + ']] '; 
	});
	n += '\\n';
}
n += '# ' + data.title;
if (data.date) {
	let year = new Date(data.date).getFullYear();
	n += ' (' + year.toString() + ')';
}
n += '\\n\\n';
if (data.children) {
	const notes = data.children.filter(
		c => c.itemType.toLowerCase() == 'note'
	)
	notes.forEach(c => {
		n += c.note_markdown + '\\n\\n';
	});
}
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
		if (storeDirectory && !fs.existsSync(storeDirectory)) {
			fs.mkdirSync(storeDirectory);
		}
		if (storeDirectory) {
			await this.store.load(storeDirectory)
		}

		// initialize the API client
		this.client = new ZoteroAPI
		this.client.on(ZoteroAPI.event.error, function() { console.log("ERROR!", [...arguments]) })
		// for (const event of [ ZoteroAPI.event.library, ZoteroAPI.event.collection, ZoteroAPI.event.item ]) {
		// 	this.client.on(event, (e => function() { console.log(e, [...arguments]) })(event))
		// }

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
		if (this.app.vault.adapter instanceof FileSystemAdapter) {
			 return path.join(
				this.app.vault.adapter.getBasePath(),
				this.app.vault.configDir,
				"plugins",
				"obsidian-zotero-sync-client",
				...append
			)
		}
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

		await this.applyAllUpdates()
		
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

	async applyUpdates(library: ZoteroRemoteLibrary) {
		const data = await this.readLibrary(library.prefix)
		const status = await this.readStatus(library.prefix)

		// compute changes
		const renames: {[key: string]: {
			from: string, to: string, note: string
		}} = {};
		const updates: {[key: string]: {
			filePath: string, note: string
		}} = {};
		const deletes: {[key: string]: string} = {};
		const creates: {[key: string]: {
			filePath: string, note: string
		}} = {};
		const updatedStatus: {
			items: Map<string, ZoteroNoteStatus>;
			collections: Map<string, ZoteroNoteStatus>;
		} = {
			items: new Map(),
			collections: new Map()
		};

		// compute renames, updates, deletes, creates
		const computeChanges = (element: ZoteroCollectionItem | ZoteroItem, status: Map<string, ZoteroNoteStatus>, updatedStatus: Map<string, ZoteroNoteStatus>) => {
			const filePath = this.generateNoteFilePath(element)
			if (!filePath) {
				return;
			}
			const note = this.getMarker(element) + this.generateNote(element) 
			const hash = md5(note)
			const key = element.key

			// check if note exists
			if (status.get(key)) {
				// does it need to be renamed?
				if (status.get(key)?.filePath != filePath) {
					// rename
					renames[key] = {from: status.get(key)?.filePath || '', to: filePath, note: note}
				}
				// does it need to be updated?
				if (status.get(key)?.hash !== hash) {
					// update
					updates[key] = {filePath: filePath, note: note}
				}

				// done
				status.delete(key)
			} else {
				// create
				creates[key] = {filePath: filePath, note: note}
			}

			// add to updated status
			updatedStatus.set(key, {
				filePath: filePath,
				hash: hash
			})
		}

		for (const element of data.collections.values()) {
			computeChanges(element, status.collections, updatedStatus.collections)
		}
		for (const [key, element] of status.collections.entries()) {
			deletes[key] = element.filePath
		}
		for (const element of data.items.values()) {
			computeChanges(element, status.items, updatedStatus.items)
		}
		for (const [key, element] of status.items.entries()) {
			deletes[key] = element.filePath
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
				await this.deleteFile(value)
			} catch (e) {
				console.log("Failed to delete file: " + value + " (" + e.message + ")");
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

	aquireFile(filePath: string) : TAbstractFile | null {
		// TODO: enable optional safety check if file has been generated by this plugin
		//       (e.g. by checking for the marker)
		return this.app.vault.getAbstractFileByPath(filePath)
	}

	async ensureDirectoryExists(filePath: string) {
		const p = path.dirname(filePath)
		if (!await this.app.vault.adapter.exists(p)) {
			await this.app.vault.createFolder(p)
		}
	}

	async renameFile(oldPath: string, newPath: string, note: string) {
		const fn = this.aquireFile(oldPath)
		await this.ensureDirectoryExists(newPath)
		if (!fn) {
			await this.app.vault.create(newPath, note)
		} else {
			await this.app.vault.rename(fn, newPath)
		}
		
	}

	async updateFile(filePath: string, note: string) {
		const fn = this.aquireFile(filePath)
		if (!fn) {
			await this.createFile(filePath, note)
		} else {
			await this.app.vault.modify(fn as TFile, note)
		}
	}

	async createFile(filePath: string, note: string) {
		const fn = this.aquireFile(filePath)
		if (fn) {
			await this.app.vault.modify(fn as TFile, note)
		} else {
			await this.ensureDirectoryExists(filePath)
			await this.app.vault.create(filePath, note)
		}
	}

	async deleteFile(filePath: string) {
		const fn = this.aquireFile(filePath)
		if (!fn) {
			return
		}
		await this.app.vault.delete(fn)
	}

	generateNoteFilePath(data: ZoteroItem | ZoteroCollectionItem, template: string | null = null) : string {
		if (!template) {
			template = this.settings.filepath_generator
		}
		const parse = new Function('data', template)
		const result = parse(data)
		if (result) {
			if (result.endsWith('.md')) {
				return normalizePath(result)
			}
			return normalizePath(result + '.md')
		} else {
			return ""
		}
	}

	generateNote(data: ZoteroItem | ZoteroCollectionItem, template: string | null = null) : string {
		if (!template) {
			template = this.settings.note_generator
		}
		const parse = new Function('data', template)
		return parse(data)
	}

	getMarker(element: ZoteroCollectionItem | ZoteroItem) {
		// Unique marker to identify note `<!-- zotero_key: ${key} -->`
		// This is prepended automatically and cannot be edited by the user
		const kind = element.itemType.toLowerCase() == "collection" ? "collections" : "items"
		return `[🇿](zotero://select/library/${kind}/${element.key})\n\n`
	}
	
	async readLibrary(library: string): Promise<{
		collections: Map<string, ZoteroCollectionItem>;
		items: Map<string, ZoteroItem>;
	}> {
		// read library data from store and organize into a map
		try {
			let data = {
				collections: [],
				items: []
			};
			const dataFile = this.getPluginPath("store", `${encodeURIComponent(library)}.json`)
			if (dataFile) {
				try {
			 		data = JSON.parse(await fs.promises.readFile(dataFile, 'utf-8'))
				} catch (e) {
					// pass
				}
			}
			let map: {
				collections: Map<string, ZoteroCollectionItem>;
				items: Map<string, ZoteroItem>;
			} = {
				collections: new Map(data.collections.map((c: ZoteroCollectionItem) => [c.key, c])),
				items: new Map(data.items.map((i: ZoteroItem) => {
					if (i.itemType.toLowerCase() === 'note' && i.note) {
						i.note_markdown = htmlToMarkdown(i.note);
					}
					return [i.key, i]
				}))
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

	async readStatus(library: string) : Promise<{
		collections: Map<string, ZoteroNoteStatus>;
		items: Map<string, ZoteroNoteStatus>;
	 }> {
		// read library status from store
		try {
			const filePath = this.getPluginPath("store", `${encodeURIComponent(library)}.status.json`)
			if (!filePath) {
				throw new Error("Unable to read library status due to invalid path");
			}
			const data = JSON.parse(await fs.promises.readFile(filePath, 'utf-8'))
			return {
				collections: new Map(data.collections.entries()),
				items: new Map(data.items.entries())
			}
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
			const filePath = this.getPluginPath("store", `${encodeURIComponent(library)}.status.json`)
			if (filePath) {
				await fs.promises.writeFile(filePath, JSON.stringify(status))
			}
		} catch (e) {
			throw new Error("Unable to write library status: " + e.message);
		}
	}

	async clearStatus(library: string) {
		// clear library status from store
		try {
			const filePath = this.getPluginPath("store", `${encodeURIComponent(library)}.status.json`)
			if (filePath) {
				await fs.promises.unlink(filePath)
			}
		} catch (e) {
			throw new Error("Unable to clear library status: " + e.message);
		}
	}

	async clearCache() {
		for (const library of Object.values(this.client.libraries)) {
			await this.clearStatus(library.prefix)
		}
		new Notice(`Zotero Sync: Cleared cache`)
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
						new Notice(`Authenticated with Zotero, syncing libraries. This may take a while...`)
						await this.plugin.sync();
						new Notice(`Zotero Sync complete.`)
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

		containerEl.createEl('h2', {text: 'Note generation'});

		new Setting(containerEl)
			.setName('Caching')
			.setDesc(
				'Generated Zotero note files are cached to improve performance; if you make changes to the note files when not using the plugin, you can use this button to clear the cache.'
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
			.setName('Template')
			.setDesc(
				'The JavaScript code in the left column below is used to generate the notes from items in your Zotero library.' +
				' You can preview code changes by selecting a file from the preview list. ' +
				' Once you are done, you can apply the changes to your vault by clicking the "Apply" button. '
			)
			.addButton(button => button
				.setButtonText('Apply')
				.onClick(async () => {
					// save settings
					button.setDisabled(true);
					this.plugin.settings.filepath_generator = fpCodeEditor.value
					this.plugin.settings.note_generator = ntCodeEditor.value
					await this.plugin.saveSettings();
					// apply changes
					new Notice('Zotero Sync: Updating vault (this may take a while)');
					await this.plugin.applyAllUpdates();
					new Notice('Zotero Sync: Vault updated');
					button.setDisabled(false);
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
			const element = data.items.get(fileSelect.value) || {} as ZoteroItem;
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
		const codeFont = 'Menlo, SFMono-Regular, Consolas, "Roboto Mono", "Source Code Pro", monospace';
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
					fpCodeEditor.style.fontFamily = codeFont;
					fpCodeEditor.style.fontSize = '9pt';
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
					ntCodeEditor.style.fontFamily = codeFont;
					ntCodeEditor.style.fontSize = '9pt';
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
