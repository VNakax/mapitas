const MODULE_ID = "modulo-dos-mapitas";
const PACK_NAME = "mapitas-scenes";
const PACK_LABEL = "Mapitas";
const MAP_ROOT = "Mapitas";
const DEFAULT_GRID_SIZE = 100;
const BATCH_SIZE = 25;
const SUPPORTED_EXTENSIONS = new Set([
  ".apng",
  ".avif",
  ".jpeg",
  ".jpg",
  ".m4v",
  ".mov",
  ".mp4",
  ".png",
  ".webm",
  ".webp"
]);

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "autoSyncOnReady", {
    name: "Sincronizar Mapitas ao iniciar",
    hint: "Quando ativo, o GM sincroniza o compendium Mapitas sempre que o mundo termina de carregar.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "lastSyncSummary", {
    name: "Ultimo resumo de sincronizacao",
    scope: "world",
    config: false,
    type: String,
    default: ""
  });

  game.modules.get(MODULE_ID).api = {
    syncCompendium: () => syncMapitasCompendium({ notify: true })
  };
});

Hooks.once("ready", () => {
  if (!game.user?.isGM) return;
  if (!game.settings.get(MODULE_ID, "autoSyncOnReady")) return;
  void syncMapitasCompendium({ notify: true });
});

async function syncMapitasCompendium({ notify = false } = {}) {
  const lock = globalThis[`${MODULE_ID}-sync-lock`];
  if (lock) return lock;

  const runner = (async () => {
    try {
      if (notify) ui.notifications.info("Mapitas: sincronizando compendium de cenas...");

      const files = await browseMapFiles(MAP_ROOT);
      if (!files.length) {
        const message = "Mapitas: nenhum arquivo suportado foi encontrado em Data/Mapitas.";
        ui.notifications.warn(message);
        await game.settings.set(MODULE_ID, "lastSyncSummary", message);
        return null;
      }

      const pack = await ensureCompendium();
      const existingDocs = await pack.getDocuments();
      const existingByPath = new Map();

      for (const doc of existingDocs) {
        const sourcePath = doc.getFlag(MODULE_ID, "sourcePath");
        if (sourcePath) existingByPath.set(normalizePath(sourcePath), doc);
      }

      const targetPaths = new Set(files.map((file) => normalizePath(file)));
      const toDelete = [];
      for (const doc of existingDocs) {
        const sourcePath = normalizePath(doc.getFlag(MODULE_ID, "sourcePath") ?? "");
        if (sourcePath && !targetPaths.has(sourcePath)) toDelete.push(doc.id);
      }

      const toCreate = [];
      const toUpdate = [];

      for (const file of files) {
        const normalizedPath = normalizePath(file);
        const existing = existingByPath.get(normalizedPath);

        if (!existing) {
          const sceneData = await buildSceneData(file);
          toCreate.push(sceneData);
          continue;
        }

        const update = buildLightweightUpdate(existing, normalizedPath);
        if (update) toUpdate.push(update);
      }

      await batchDeleteDocuments(toDelete, pack.collection);
      await batchCreateDocuments(toCreate, pack.collection);
      await batchUpdateDocuments(toUpdate, pack.collection);

      const summary = [
        `Mapitas sincronizado com sucesso.`,
        `Arquivos encontrados: ${files.length}.`,
        `Criados: ${toCreate.length}.`,
        `Atualizados: ${toUpdate.length}.`,
        `Removidos: ${toDelete.length}.`
      ].join(" ");

      await game.settings.set(MODULE_ID, "lastSyncSummary", summary);
      if (notify) ui.notifications.info(summary);
      return { files: files.length, created: toCreate.length, updated: toUpdate.length, removed: toDelete.length };
    } catch (error) {
      console.error(`${MODULE_ID} | Erro ao sincronizar Mapitas`, error);
      const message = "Mapitas: falha ao sincronizar. Veja o console do navegador para detalhes.";
      if (notify) ui.notifications.error(message);
      await game.settings.set(MODULE_ID, "lastSyncSummary", message);
      throw error;
    } finally {
      delete globalThis[`${MODULE_ID}-sync-lock`];
    }
  })();

  globalThis[`${MODULE_ID}-sync-lock`] = runner;
  return runner;
}

async function ensureCompendium() {
  let pack = game.packs.find((candidate) => candidate.metadata.packageType === "world" && candidate.metadata.name === PACK_NAME);
  if (pack) return pack;

  pack = await foundry.documents.collections.CompendiumCollection.createCompendium({
    label: PACK_LABEL,
    name: PACK_NAME,
    type: "Scene"
  });

  return pack;
}

async function browseMapFiles(root) {
  const queue = [normalizePath(root)];
  const discovered = [];
  const visited = new Set();

  while (queue.length) {
    const current = queue.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);

    let result;
    try {
      result = await FilePicker.browse("data", current);
    } catch (error) {
      if (current === normalizePath(root)) {
        throw new Error(`Nao foi possivel acessar a pasta "${root}" em User Data.`);
      }
      console.warn(`${MODULE_ID} | Falha ao navegar ${current}`, error);
      continue;
    }

    for (const dir of result.dirs ?? []) queue.push(normalizePath(dir));
    for (const file of result.files ?? []) {
      if (isSupportedMap(file)) discovered.push(normalizePath(file));
    }
  }

  discovered.sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }));
  return discovered;
}

function isSupportedMap(filePath) {
  const lower = filePath.toLowerCase();
  for (const ext of SUPPORTED_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

async function buildSceneData(filePath) {
  const normalizedPath = normalizePath(filePath);
  const relativePath = getRelativePath(normalizedPath);
  const assetPath = getAssetPath(normalizedPath);
  const dimensions = await getTextureDimensions(assetPath);
  const sceneName = getSceneNameFromPath(normalizedPath);

  return {
    name: sceneName,
    width: dimensions.width,
    height: dimensions.height,
    background: {
      src: assetPath
    },
    grid: {
      size: DEFAULT_GRID_SIZE,
      type: CONST.GRID_TYPES.SQUARE,
      distance: 5,
      units: "ft"
    },
    navigation: false,
    tokenVision: false,
    flags: {
      [MODULE_ID]: {
        sourcePath: normalizedPath,
        relativePath,
        syncedAt: new Date().toISOString()
      }
    }
  };
}

async function getTextureDimensions(src) {
  try {
    const texture = await foundry.canvas.loadTexture(src);
    const baseTexture = texture?.baseTexture ?? texture;
    const resource = baseTexture?.resource;
    const width = Math.round(
      resource?.source?.videoWidth ||
      resource?.source?.naturalWidth ||
      texture?.width ||
      baseTexture?.realWidth ||
      baseTexture?.width ||
      0
    );
    const height = Math.round(
      resource?.source?.videoHeight ||
      resource?.source?.naturalHeight ||
      texture?.height ||
      baseTexture?.realHeight ||
      baseTexture?.height ||
      0
    );

    if (width > 0 && height > 0) return { width, height };
  } catch (error) {
    console.warn(`${MODULE_ID} | Nao foi possivel ler dimensoes de ${src}`, error);
  }

  return { width: 4000, height: 3000 };
}

function buildLightweightUpdate(existing, sourcePath) {
  const nextName = getSceneNameFromPath(sourcePath);
  const currentPath = normalizePath(existing.getFlag(MODULE_ID, "sourcePath") ?? "");
  const nextPath = normalizePath(sourcePath);
  const nextAssetPath = getAssetPath(nextPath);
  const currentSource = normalizePath(existing.background?.src ?? "");

  const changed =
    existing.name !== nextName ||
    currentSource !== normalizePath(nextAssetPath) ||
    currentPath !== nextPath;

  if (!changed) return null;

  return {
    _id: existing.id,
    name: nextName,
    background: {
      src: nextAssetPath
    },
    flags: {
      [MODULE_ID]: {
        sourcePath: nextPath,
        relativePath: getRelativePath(nextPath),
        syncedAt: new Date().toISOString()
      }
    }
  };
}

function getSceneNameFromPath(filePath) {
  return getRelativePath(filePath)
    .replace(/\.[^.]+$/u, "")
    .split("/")
    .join(" / ");
}

function getRelativePath(filePath) {
  const normalizedPath = normalizePath(filePath);
  return normalizedPath.startsWith(`${MAP_ROOT}/`)
    ? normalizedPath.slice(MAP_ROOT.length + 1)
    : normalizedPath;
}

async function batchCreateDocuments(documents, pack) {
  for (let index = 0; index < documents.length; index += BATCH_SIZE) {
    const chunk = documents.slice(index, index + BATCH_SIZE);
    await Scene.createDocuments(chunk, { pack });
  }
}

async function batchUpdateDocuments(documents, pack) {
  for (let index = 0; index < documents.length; index += BATCH_SIZE) {
    const chunk = documents.slice(index, index + BATCH_SIZE);
    await Scene.updateDocuments(chunk, { pack });
  }
}

async function batchDeleteDocuments(ids, pack) {
  for (let index = 0; index < ids.length; index += BATCH_SIZE) {
    const chunk = ids.slice(index, index + BATCH_SIZE);
    await Scene.deleteDocuments(chunk, { pack });
  }
}

function normalizePath(path) {
  return String(path ?? "").replace(/\\/gu, "/").replace(/\/+/gu, "/").replace(/\/$/u, "");
}

function getAssetPath(path) {
  const normalizedPath = normalizePath(path);
  return foundry.utils.getRoute(foundry.utils.encodeURL(normalizedPath));
}
