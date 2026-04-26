const MODULE_ID = "modulo-dos-mapitas";
const MODULE_PATH = `modules/${MODULE_ID}`;
const CATALOG_URL = `${MODULE_PATH}/catalog/index.json`;

let browserApp = null;

Hooks.once("init", () => {
  game.modules.get(MODULE_ID).api = {
    openBrowser: () => openMapitasBrowser(),
    importSceneById: (sceneId) => importCatalogSceneById(sceneId),
    reloadCatalog: () => browserApp?.reloadCatalog()
  };
});

Hooks.on("renderSceneDirectory", (app, html) => {
  if (!game.user?.isGM) return;
  installDirectoryButton(resolveHtmlRoot(app, html));
});

Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user?.isGM) return;

  const target =
    controls.tokens ??
    controls.notes ??
    Object.values(controls)[0];

  if (!target) return;
  target.tools ??= {};
  if (target.tools.mapitasBrowser) return;

  target.tools.mapitasBrowser = {
    name: "mapitasBrowser",
    title: "Mapitas Browser",
    icon: "fas fa-map",
    button: true,
    visible: true,
    onChange: () => openMapitasBrowser()
  };
});

function openMapitasBrowser() {
  if (!browserApp) browserApp = new MapitasBrowser();
  browserApp.render(true);
  return browserApp;
}

async function importCatalogSceneById(sceneId) {
  const browser = browserApp ?? new MapitasBrowser();
  await browser.loadCatalog();
  const entry = browser.catalog?.entries?.find((candidate) => candidate.id === sceneId);
  if (!entry) throw new Error(`Mapitas: cena "${sceneId}" nao encontrada no catalogo.`);
  return browser.importEntry(entry);
}

class MapitasBrowser extends Application {
  constructor(options = {}) {
    super(options);
    this.catalog = null;
    this.sceneCache = new Map();
    this.state = {
      query: "",
      selectedFolder: "",
      selectedSceneId: "",
      folderScrollTop: 0,
      resultsScrollTop: 0,
      focusSearch: false,
      querySelectionStart: null,
      querySelectionEnd: null
    };
    this.directoryCache = new Map();
    this.pendingSearchRender = null;
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "mapitas-browser",
      classes: ["mapitas-browser"],
      template: `${MODULE_PATH}/templates/browser.hbs`,
      title: "Mapitas",
      width: 1280,
      height: 820,
      resizable: true
    });
  }

  async loadCatalog({ force = false } = {}) {
    if (this.catalog && !force) return this.catalog;

    const response = await fetch(CATALOG_URL, { cache: "no-store" });
    if (!response.ok) throw new Error("Mapitas: falha ao carregar o catalogo do modulo.");
    const catalog = await response.json();
    catalog.entries = Array.isArray(catalog.entries) ? catalog.entries : [];
    this.catalog = catalog;

    if (!this.state.selectedSceneId && catalog.entries.length) {
      this.state.selectedSceneId = catalog.entries[0].id;
    }

    return catalog;
  }

  async reloadCatalog() {
    this.sceneCache.clear();
    await this.loadCatalog({ force: true });
    return this.render(false);
  }

  async getData() {
    await this.loadCatalog();

    const entries = this.catalog.entries;
    const shouldRenderResults = Boolean(this.state.selectedFolder || this.state.query);
    const visibleEntries = shouldRenderResults ? filterEntries(entries, this.state.query, this.state.selectedFolder) : [];
    const countEntries = filterEntries(entries, this.state.query, "");
    const folders = buildFolderList(entries, countEntries);
    for (const folder of folders) {
      folder.selected = folder.key === this.state.selectedFolder;
    }

    if (!visibleEntries.some((entry) => entry.id === this.state.selectedSceneId)) {
      this.state.selectedSceneId = visibleEntries[0]?.id ?? "";
    }

    const selectedEntry = visibleEntries.find((entry) => entry.id === this.state.selectedSceneId) ?? null;

    return {
      query: this.state.query,
      selectedFolder: this.state.selectedFolder,
      totalEntries: entries.length,
      visibleCount: visibleEntries.length,
      shouldRenderResults,
      folders,
      scenes: visibleEntries.map((entry) => ({
        ...entry,
        selected: entry.id === this.state.selectedSceneId,
        previewSrc: entry.preview || entry.thumb || entry.background,
        folderLabel: entry.folderPath?.join(" / ") || "Sem pasta",
        previewWidth: Math.max(Number(entry.width) || 1, 1),
        previewHeight: Math.max(Number(entry.height) || 1, 1)
      })),
      selectedScene: selectedEntry ? {
        ...selectedEntry,
        previewSrc: selectedEntry.preview || selectedEntry.thumb || selectedEntry.background,
        folderLabel: selectedEntry.folderPath?.join(" / ") || "Sem pasta",
        previewWidth: Math.max(Number(selectedEntry.width) || 1, 1),
        previewHeight: Math.max(Number(selectedEntry.height) || 1, 1)
      } : null
    };
  }

  activateListeners(html) {
    super.activateListeners(html);
    const folderList = html.find(".mapitas-folder-list")[0];
    const resultsList = html.find(".mapitas-results")[0];

    if (folderList) {
      folderList.scrollTop = this.state.folderScrollTop ?? 0;
      folderList.addEventListener("scroll", () => {
        this.state.folderScrollTop = folderList.scrollTop;
      });
    }

    if (resultsList) {
      resultsList.scrollTop = this.state.resultsScrollTop ?? 0;
      resultsList.addEventListener("scroll", () => {
        this.state.resultsScrollTop = resultsList.scrollTop;
      });
    }

    const searchInput = html.find("[data-action='search']")[0];
    if (searchInput && this.state.focusSearch) {
      searchInput.focus();
      const start = this.state.querySelectionStart ?? searchInput.value.length;
      const end = this.state.querySelectionEnd ?? start;
      searchInput.setSelectionRange(start, end);
    }

    html.find("[data-action='search']").on("input", (event) => {
      this.state.resultsScrollTop = 0;
      this.state.focusSearch = true;
      this.state.query = String(event.currentTarget.value ?? "");
      this.state.querySelectionStart = event.currentTarget.selectionStart;
      this.state.querySelectionEnd = event.currentTarget.selectionEnd;
      this.scheduleSearchRender();
    });

    html.find("[data-action='select-folder']").on("click", (event) => {
      this.state.focusSearch = false;
      this.state.folderScrollTop = folderList?.scrollTop ?? this.state.folderScrollTop;
      this.state.resultsScrollTop = 0;
      this.state.selectedFolder = String(event.currentTarget.dataset.folder ?? "");
      this.render(false);
    });

    html.find("[data-action='select-scene']").on("click", (event) => {
      this.state.focusSearch = false;
      this.state.selectedSceneId = String(event.currentTarget.dataset.sceneId ?? "");
      this.render(false);
    });

    html.find("[data-action='import-scene']").on("click", async (event) => {
      this.state.focusSearch = false;
      const sceneId = String(event.currentTarget.dataset.sceneId ?? "");
      const entry = this.catalog.entries.find((candidate) => candidate.id === sceneId);
      if (!entry) return;

      const button = event.currentTarget;
      button.disabled = true;
      try {
        await this.importEntry(entry);
      } catch (error) {
        console.error(error);
        ui.notifications.error(error.message ?? "Mapitas: falha ao importar a cena.");
      } finally {
        button.disabled = false;
      }
    });
  }

  async importEntry(entry) {
    const sceneData = await this.loadSceneData(entry);
    const backgroundPath = normalizePath(sceneData.background?.src ?? entry.background ?? "");
    if (!backgroundPath) throw new Error(`Mapitas: a cena "${entry.name}" nao possui background configurado.`);

    const exists = await this.assetExists(backgroundPath);
    if (!exists) {
      throw new Error(`Mapitas: asset nao encontrado em "${backgroundPath}".`);
    }

    const folderId = await ensureWorldSceneFolders(sceneData.folderPath ?? entry.folderPath ?? []);
    const payload = buildWorldScenePayload(entry, sceneData, folderId);
    const existing = game.scenes.find((scene) => scene.getFlag(MODULE_ID, "catalogId") === entry.id);

    let document;
    if (existing) {
      document = await existing.update(payload);
      ui.notifications.info(`Mapitas: cena atualizada: ${entry.name}.`);
    } else {
      document = await Scene.create(payload);
      ui.notifications.info(`Mapitas: cena importada: ${entry.name}.`);
    }

    await refreshSceneDirectory();

    return document;
  }

  async loadSceneData(entry) {
    if (this.sceneCache.has(entry.id)) return this.sceneCache.get(entry.id);

    const response = await fetch(entry.scene, { cache: "no-store" });
    if (!response.ok) throw new Error(`Mapitas: falha ao carregar os dados da cena "${entry.name}".`);
    const sceneData = await response.json();
    this.sceneCache.set(entry.id, sceneData);
    return sceneData;
  }

  async assetExists(path) {
    const normalizedPath = normalizePath(path);
    const parent = normalizedPath.slice(0, normalizedPath.lastIndexOf("/"));
    if (!parent) return false;

    let files = this.directoryCache.get(parent);
    if (!files) {
      const result = await FilePicker.browse("data", parent);
      files = new Set((result.files ?? []).map((file) => normalizePath(file)));
      this.directoryCache.set(parent, files);
    }

    return files.has(normalizedPath) || files.has(encodeURI(normalizedPath));
  }

  scheduleSearchRender() {
    if (this.pendingSearchRender) clearTimeout(this.pendingSearchRender);
    this.pendingSearchRender = setTimeout(() => {
      this.pendingSearchRender = null;
      this.render(false);
    }, 120);
  }
}

function filterEntries(entries, query, selectedFolder) {
  const needle = query.trim().toLocaleLowerCase();
  return entries.filter((entry) => {
    const matchesFolder = !selectedFolder || (entry.folderPath ?? []).join("/") === selectedFolder || (entry.folderPath ?? []).join("/").startsWith(`${selectedFolder}/`);
    if (!matchesFolder) return false;
    if (!needle) return true;

    const haystack = [
      entry.name,
      ...(entry.variants ?? []),
      ...(entry.folderPath ?? [])
    ].join(" ").toLocaleLowerCase();
    return haystack.includes(needle);
  });
}

function buildFolderList(allEntries, visibleEntries) {
  const counts = new Map();
  for (const entry of visibleEntries) {
    const folderPath = entry.folderPath ?? [];
    for (let index = 0; index < folderPath.length; index += 1) {
      const key = folderPath.slice(0, index + 1).join("/");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const allFolders = new Set();
  for (const entry of allEntries) {
    const folderPath = entry.folderPath ?? [];
    for (let index = 0; index < folderPath.length; index += 1) {
      allFolders.add(folderPath.slice(0, index + 1).join("/"));
    }
  }

  return [
    {
      key: "",
      label: "Todas as cenas",
      depth: 0,
      count: visibleEntries.length,
      selected: false
    },
    ...Array.from(allFolders)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => {
        const parts = key.split("/");
        return {
          key,
          label: parts.at(-1),
          depth: parts.length,
          count: counts.get(key) ?? 0,
          selected: false
        };
      })
  ];
}

function buildWorldScenePayload(entry, sceneData, folderId) {
  const payload = foundry.utils.deepClone(sceneData);
  payload.folder = folderId;
  payload.thumb ||= entry.preview || entry.thumb || payload.background?.src || entry.background;
  payload.ownership = { default: 0 };
  payload.flags = {
    ...(payload.flags ?? {}),
    [MODULE_ID]: {
      ...(payload.flags?.[MODULE_ID] ?? {}),
      catalogId: entry.id,
      importedAt: new Date().toISOString(),
      sourcePath: payload.background?.src ?? entry.background
    }
  };
  delete payload._id;
  delete payload.id;
  delete payload.folderPath;
  return payload;
}

async function ensureWorldSceneFolders(folderPath) {
  if (!Array.isArray(folderPath) || !folderPath.length) return null;

  const cache = globalThis[`${MODULE_ID}-world-folder-cache`] ?? new Map();
  globalThis[`${MODULE_ID}-world-folder-cache`] = cache;

  let parentId = null;
  const pathParts = [];
  for (const segment of folderPath) {
    pathParts.push(segment);
    const key = pathParts.join("/");
    const cached = cache.get(key);
    if (cached) {
      parentId = cached.id;
      continue;
    }

    let folder = game.folders.find((candidate) =>
      candidate.type === "Scene" &&
      candidate.name === segment &&
      (candidate.folder?.id ?? null) === parentId &&
      candidate.getFlag(MODULE_ID, "folderPath") === key
    );

    if (!folder) {
      [folder] = await Folder.createDocuments([{
        name: segment,
        type: "Scene",
        folder: parentId,
        sorting: "a",
        flags: {
          [MODULE_ID]: {
            folderPath: key
          }
        }
      }]);
    }

    cache.set(key, folder);
    parentId = folder.id;
  }

  return parentId;
}

function normalizePath(path) {
  const normalized = String(path ?? "").replace(/\\/gu, "/").replace(/\/+/gu, "/").replace(/\/$/u, "");
  try {
    return decodeURIComponent(normalized);
  } catch {
    return normalized;
  }
}

function installDirectoryButton(root) {
  if (!(root instanceof HTMLElement)) return;
  if (root.querySelector(".mapitas-directory-launch")) return;

  const wrapper = document.createElement("div");
  wrapper.className = "mapitas-directory-launch";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "mapitas-directory-button";
  button.innerHTML = `<i class="fas fa-map"></i> Mapitas`;
  button.addEventListener("click", () => openMapitasBrowser());
  wrapper.append(button);

  const anchor = root.querySelector(".header-actions, .action-buttons, .controls, header");
  if (anchor?.parentElement) anchor.insertAdjacentElement("afterend", wrapper);
  else root.prepend(wrapper);
}

function resolveHtmlRoot(app, html) {
  if (html?.jquery) return html[0] ?? null;
  if (html instanceof HTMLElement) return html;
  if (Array.isArray(html) && html[0] instanceof HTMLElement) return html[0];

  const fallback = app?.element;
  if (fallback?.jquery) return fallback[0] ?? null;
  if (fallback instanceof HTMLElement) return fallback;
  if (Array.isArray(fallback) && fallback[0] instanceof HTMLElement) return fallback[0];

  return null;
}

async function refreshSceneDirectory() {
  const directory = ui.sidebar?.tabs?.scenes;
  if (!directory?.render) return;
  await directory.render(true);
}
