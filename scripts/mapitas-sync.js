const MODULE_ID = "modulo-dos-mapitas";
const PACK_NAME = "mapitas-scenes";
const PACK_LABEL = "Mapitas";
const MAP_ROOT = "Mapitas";
const DEFAULT_GRID_SIZE = 100;
const BROWSE_DELAY_MS = 120;
const WRITE_DELAY_MS = 300;
const DELETE_BATCH_SIZE = 5;
const WRITE_BATCH_SIZE = 1;
const PROGRESS_STEP = 5;
const ASSET_CONTAINER_NAMES = new Set(["assets", "files", "images", "img", "map", "maps", "media"]);
const IGNORED_NAME_TOKENS = new Set([
  "alt",
  "art",
  "base",
  "color",
  "colour",
  "export",
  "final",
  "full",
  "grid",
  "gridded",
  "gridless",
  "high",
  "highlight",
  "highlights",
  "hq",
  "jpg",
  "jpeg",
  "light",
  "lights",
  "map",
  "maps",
  "nighttime",
  "nogrid",
  "original",
  "png",
  "preview",
  "scene",
  "token",
  "ungrid",
  "ungridded",
  "variant",
  "vtt",
  "webp"
]);
const VARIANT_LABELS = new Map([
  ["day", "Day"],
  ["night", "Night"],
  ["dawn", "Dawn"],
  ["dusk", "Dusk"],
  ["sunrise", "Sunrise"],
  ["sunset", "Sunset"],
  ["storm", "Storm"],
  ["rain", "Rain"],
  ["snow", "Snow"],
  ["winter", "Winter"],
  ["summer", "Summer"],
  ["spring", "Spring"],
  ["autumn", "Autumn"],
  ["fall", "Autumn"],
  ["gridless", "Gridless"],
  ["ungridded", "Gridless"],
  ["gridded", "Gridded"],
  ["grid", "Gridded"],
  ["player", "Player"],
  ["gm", "GM"]
]);
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

  game.settings.register(MODULE_ID, "initialSyncConfirmed", {
    name: "Sincronizacao inicial confirmada",
    scope: "world",
    config: false,
    type: Boolean,
    default: false
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
      reportProgress({ notify, message: "Mapitas: iniciando sincronizacao...", force: true, pct: 1 });

      const pack = await ensureCompendium();
      const existingDocs = await pack.getDocuments();
      const initialAction = await ensureInitialSyncApproval({ notify, pack, existingDocs });
      if (initialAction === "cancel") return null;

      let workingDocs = existingDocs;
      if (initialAction === "clear") {
        reportProgress({ notify, message: "Mapitas: limpando compendium antes da primeira sincronizacao...", force: true, pct: 2 });
        await processDocumentBatches({
          items: existingDocs.map((doc) => doc.id),
          batchSize: DELETE_BATCH_SIZE,
          delayMs: WRITE_DELAY_MS,
          notify,
          label: "Limpando compendium",
          startPct: 2,
          endPct: 8,
          processor: async (chunk) => {
            await Scene.deleteDocuments(chunk, { pack: pack.collection });
          }
        });
        workingDocs = [];
      }

      const files = await browseMapFiles(MAP_ROOT, { notify, startPct: 8, endPct: 35 });
      if (!files.length) {
        const message = "Mapitas: nenhum arquivo suportado foi encontrado em Data/Mapitas.";
        ui.notifications.warn(message);
        await game.settings.set(MODULE_ID, "lastSyncSummary", message);
        return null;
      }

      const existingByPath = new Map();

      for (const doc of workingDocs) {
        const sourcePath = doc.getFlag(MODULE_ID, "sourcePath");
        if (sourcePath) existingByPath.set(normalizePath(sourcePath), doc);
      }

      reportProgress({
        notify,
        message: `Mapitas: ${files.length} arquivos encontrados. Comparando com o compendium...`,
        force: true,
        pct: 40
      });

      const targetPaths = new Set(files.map((file) => normalizePath(file)));
      const toDelete = [];
      for (const doc of workingDocs) {
        const sourcePath = normalizePath(doc.getFlag(MODULE_ID, "sourcePath") ?? "");
        if (sourcePath && !targetPaths.has(sourcePath)) toDelete.push(doc.id);
      }

      const stats = {
        files: files.length,
        created: 0,
        updated: 0,
        removed: 0
      };

      await processDocumentBatches({
        items: toDelete,
        batchSize: DELETE_BATCH_SIZE,
        delayMs: WRITE_DELAY_MS,
        notify,
        label: "Removendo cenas antigas",
        startPct: 40,
        endPct: 50,
        processor: async (chunk) => {
          await Scene.deleteDocuments(chunk, { pack: pack.collection });
          stats.removed += chunk.length;
        }
      });

      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const normalizedPath = normalizePath(file);
        const existing = existingByPath.get(normalizedPath);

        if (!existing) {
          const sceneData = await buildSceneData(file);
          await flushCreateBatch([sceneData], pack.collection, stats, notify, index + 1, files.length);
        } else {
          const update = buildLightweightUpdate(existing, normalizedPath);
          if (update) await flushUpdateBatch([update], pack.collection, stats, notify, index + 1, files.length);
        }

        if (((index + 1) % PROGRESS_STEP) === 0 || (index + 1) === files.length) {
          const pct = getLinearProgress(index + 1, files.length, 50, 98);
          reportProgress({
            notify,
            message: [
              `Mapitas: analisados ${index + 1}/${files.length} mapas.`,
              `Criados: ${stats.created}.`,
              `Atualizados: ${stats.updated}.`,
              `Removidos: ${stats.removed}.`
            ].join(" "),
            pct
          });
        }
      }

      const summary = [
        `Mapitas sincronizado com sucesso.`,
        `Arquivos encontrados: ${files.length}.`,
        `Criados: ${stats.created}.`,
        `Atualizados: ${stats.updated}.`,
        `Removidos: ${stats.removed}.`
      ].join(" ");

      await game.settings.set(MODULE_ID, "initialSyncConfirmed", true);
      await game.settings.set(MODULE_ID, "lastSyncSummary", summary);
      reportProgress({ notify, message: summary, force: true, pct: 100 });
      return stats;
    } catch (error) {
      console.error(`${MODULE_ID} | Erro ao sincronizar Mapitas`, error);
      const message = "Mapitas: falha ao sincronizar. Veja o console do navegador para detalhes.";
      if (notify) ui.notifications.error(message);
      await game.settings.set(MODULE_ID, "lastSyncSummary", message);
      throw error;
    } finally {
      delete globalThis[`${MODULE_ID}-sync-lock`];
      delete globalThis[`${MODULE_ID}-progress-state`];
      clearProgressBar();
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

async function browseMapFiles(root, { notify = false, startPct = 0, endPct = 25 } = {}) {
  const queue = [normalizePath(root)];
  const discovered = [];
  const visited = new Set();
  let scanned = 0;

  while (queue.length) {
    const current = queue.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    scanned += 1;

    if (scanned === 1 || (scanned % PROGRESS_STEP) === 0) {
      reportProgress({
        notify,
        message: `Mapitas: varrendo pastas... ${scanned} pasta(s) visitada(s), ${discovered.length} arquivo(s) encontrado(s).`,
        pct: getBrowseProgress(scanned, queue.length, startPct, endPct)
      });
    }

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

    await wait(BROWSE_DELAY_MS);
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
  const dimensions = await getTextureDimensions(normalizedPath);
  const sceneName = getSceneNameFromPath(normalizedPath);

  return {
    name: sceneName,
    width: dimensions.width,
    height: dimensions.height,
    background: {
      src: normalizedPath
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
  if (isVideoPath(src)) return { width: 4000, height: 3000 };
  return { width: 4000, height: 3000 };
}

function buildLightweightUpdate(existing, sourcePath) {
  const nextName = getSceneNameFromPath(sourcePath);
  const currentPath = normalizePath(existing.getFlag(MODULE_ID, "sourcePath") ?? "");
  const nextPath = normalizePath(sourcePath);
  const currentSource = normalizePath(existing.background?.src ?? "");

  const changed =
    existing.name !== nextName ||
    currentSource !== nextPath ||
    currentPath !== nextPath;

  if (!changed) return null;

  return {
    _id: existing.id,
    name: nextName,
    background: {
      src: nextPath
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
  const relativePath = decodePathForDisplay(getRelativePath(filePath)).replace(/\.[^.]+$/u, "");
  const segments = relativePath.split("/").filter(Boolean);
  const fileBaseName = segments.at(-1) ?? relativePath;
  const folderBaseName = findBestFolderName(segments.slice(0, -1));
  const primaryName = folderBaseName || formatFileBaseName(fileBaseName) || "Mapa";
  const variants = extractVariants(fileBaseName);

  return variants.length ? `${primaryName} (${variants.join(", ")})` : primaryName;
}

function getRelativePath(filePath) {
  const normalizedPath = normalizePath(filePath);
  return normalizedPath.startsWith(`${MAP_ROOT}/`)
    ? normalizedPath.slice(MAP_ROOT.length + 1)
    : normalizedPath;
}

async function processDocumentBatches({ items, batchSize, delayMs, notify, label, startPct = 0, endPct = 100, processor }) {
  for (let index = 0; index < items.length; index += batchSize) {
    const chunk = items.slice(index, index + batchSize);
    await processor(chunk);
    const processed = Math.min(index + chunk.length, items.length);
    reportProgress({
      notify,
      message: `Mapitas: ${label} ${processed}/${items.length}...`,
      pct: getLinearProgress(processed, items.length, startPct, endPct)
    });
    await wait(delayMs);
  }
}

async function flushCreateBatch(queue, pack, stats, notify, processed = 0, total = 0) {
  if (!queue.length) return;
  const chunk = queue.splice(0, queue.length);
  await Scene.createDocuments(chunk, { pack });
  stats.created += chunk.length;
  reportProgress({
    notify,
    message: `Mapitas: criando cenas... ${stats.created} criada(s), ${stats.updated} atualizada(s), ${stats.removed} removida(s).`,
    pct: getLinearProgress(processed, total, 50, 98)
  });
  await wait(WRITE_DELAY_MS);
}

async function flushUpdateBatch(queue, pack, stats, notify, processed = 0, total = 0) {
  if (!queue.length) return;
  const chunk = queue.splice(0, queue.length);
  await Scene.updateDocuments(chunk, { pack });
  stats.updated += chunk.length;
  reportProgress({
    notify,
    message: `Mapitas: atualizando cenas... ${stats.created} criada(s), ${stats.updated} atualizada(s), ${stats.removed} removida(s).`,
    pct: getLinearProgress(processed, total, 50, 98)
  });
  await wait(WRITE_DELAY_MS);
}

function findBestFolderName(segments) {
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    const normalized = normalizeNameToken(segment);
    if (!normalized || ASSET_CONTAINER_NAMES.has(normalized)) continue;
    return formatLabel(segment);
  }
}

function formatFileBaseName(fileBaseName) {
  const words = tokenizeName(fileBaseName)
    .filter((word) => !IGNORED_NAME_TOKENS.has(word))
    .filter((word) => !VARIANT_LABELS.has(word));

  if (!words.length) return "";
  return titleCaseWords(words);
}

function extractVariants(fileBaseName) {
  const variants = [];
  for (const token of tokenizeName(fileBaseName)) {
    const label = VARIANT_LABELS.get(token);
    if (label && !variants.includes(label)) variants.push(label);
  }
  return variants;
}

function normalizePath(path) {
  return String(path ?? "").replace(/\\/gu, "/").replace(/\/+/gu, "/").replace(/\/$/u, "");
}

function isVideoPath(path) {
  const lower = normalizePath(path).toLowerCase();
  return lower.endsWith(".webm") || lower.endsWith(".mp4") || lower.endsWith(".m4v") || lower.endsWith(".mov");
}

function tokenizeName(value) {
  return String(value ?? "")
    .replace(/\.[^.]+$/u, "")
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/[_-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase()
    .split(" ")
    .filter(Boolean);
}

function formatLabel(value) {
  const words = tokenizeName(value).filter((word) => !IGNORED_NAME_TOKENS.has(word));
  return words.length ? titleCaseWords(words) : titleCaseWords(tokenizeName(value));
}

function titleCaseWords(words) {
  return words
    .map((word) => {
      if (word === "gm") return "GM";
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

function normalizeNameToken(value) {
  return tokenizeName(value).join(" ");
}

function reportProgress({ notify, message, force = false, pct = null }) {
  console.info(`${MODULE_ID} | ${message}`);
  updateProgressBar({ message, pct });
  if (!notify) return;

  const state = globalThis[`${MODULE_ID}-progress-state`] ?? { lastMessage: "", lastAt: 0 };
  const now = Date.now();
  if (!force && state.lastMessage === message) return;
  if (!force && (now - state.lastAt) < 3000) return;

  globalThis[`${MODULE_ID}-progress-state`] = { lastMessage: message, lastAt: now };
  if (force) ui.notifications.info(message);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureInitialSyncApproval({ notify, pack, existingDocs }) {
  if (game.settings.get(MODULE_ID, "initialSyncConfirmed")) return "keep";

  const hasExistingDocs = existingDocs.length > 0;
  const content = [
    "<p>Esta e a primeira execucao do modulo neste mundo.</p>",
    "<p>Deseja iniciar a sincronizacao do compendium <strong>Mapitas</strong> agora?</p>",
    hasExistingDocs ? `<p>Existem ${existingDocs.length} cena(s) no compendium atual. Voce pode limpar essas cenas antes de importar novamente.</p>` : ""
  ].join("");

  const action = await new Promise((resolve) => {
    const buttons = {
      cancel: {
        label: "Cancelar",
        callback: () => resolve("cancel")
      },
      keep: {
        label: "Sincronizar",
        callback: () => resolve("keep")
      }
    };

    if (hasExistingDocs) {
      buttons.clear = {
        label: "Limpar e Sincronizar",
        callback: () => resolve("clear")
      };
    }

    new Dialog({
      title: "Mapitas: primeira sincronizacao",
      content,
      buttons,
      default: hasExistingDocs ? "clear" : "keep",
      close: () => resolve("cancel")
    }).render(true);
  });

  if (action === "cancel") {
    const message = "Mapitas: sincronizacao inicial cancelada pelo GM.";
    if (notify) ui.notifications.warn(message);
    await game.settings.set(MODULE_ID, "lastSyncSummary", message);
    return "cancel";
  }

  return action;
}

function decodePathForDisplay(path) {
  return normalizePath(path)
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");
}

function updateProgressBar({ message, pct }) {
  const safePct = Number.isFinite(pct) ? Math.max(0, Math.min(100, Math.round(pct))) : null;
  globalThis[`${MODULE_ID}-progress-bar`] = {
    label: message,
    pct: safePct ?? globalThis[`${MODULE_ID}-progress-bar`]?.pct ?? 0
  };

  if (typeof SceneNavigation?.displayProgressBar !== "function") return;
  SceneNavigation.displayProgressBar({
    label: message,
    pct: globalThis[`${MODULE_ID}-progress-bar`].pct
  });
}

function clearProgressBar() {
  delete globalThis[`${MODULE_ID}-progress-bar`];
  if (typeof SceneNavigation?.displayProgressBar !== "function") return;
  SceneNavigation.displayProgressBar({
    label: "Mapitas",
    pct: 100
  });
}

function getLinearProgress(current, total, startPct, endPct) {
  if (!total) return startPct;
  const ratio = Math.max(0, Math.min(1, current / total));
  return startPct + ((endPct - startPct) * ratio);
}

function getBrowseProgress(scanned, queueLength, startPct, endPct) {
  const estimatedTotal = Math.max(scanned + queueLength, scanned, 1);
  return getLinearProgress(scanned, estimatedTotal, startPct, endPct);
}
