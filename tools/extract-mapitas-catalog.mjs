import fs from "node:fs/promises";
import path from "node:path";
import { Level } from "level";
import sharp from "sharp";

const MODULE_ID = "modulo-dos-mapitas";
const DEFAULT_WORLD_ROOT = path.resolve("mapitas");
const DEFAULT_OUTPUT_ROOT = path.resolve("catalog");
const DEFAULT_ASSETS_ROOT = path.resolve("Mapitas");
const EMBEDDED_TYPES = new Set(["walls", "lights", "drawings", "notes", "tiles", "sounds", "regions"]);
const PREVIEW_FOLDER_NAME = "previews-clean";

const options = parseArgs(process.argv.slice(2));
const worldRoot = path.resolve(options.world ?? DEFAULT_WORLD_ROOT);
const outputRoot = path.resolve(options.out ?? DEFAULT_OUTPUT_ROOT);
const assetsRoot = path.resolve(options.assets ?? DEFAULT_ASSETS_ROOT);

await fs.mkdir(path.join(outputRoot, "scenes"), { recursive: true });
await fs.mkdir(path.join(outputRoot, PREVIEW_FOLDER_NAME), { recursive: true });
await clearDirectory(path.join(outputRoot, "scenes"));
await clearDirectory(path.join(outputRoot, PREVIEW_FOLDER_NAME));

const folders = await readFolders(path.join(worldRoot, "data", "folders"));
const { scenes, embedded } = await readScenes(path.join(worldRoot, "data", "scenes"));

const entries = [];
for (const scene of scenes.values()) {
  const mappedBackground = mapBackground(scene.background?.src);
  if (!mappedBackground) continue;

  const publisherId = mappedBackground.split("/")[1] ?? "mapitas";
  if (options.publisher && publisherId !== options.publisher) continue;

  const slug = `${publisherId}-${scene._id}`;
  const folderPath = normalizeFolderPath([titleCase(publisherId), ...resolveFolderPath(scene.folder, folders)]);
  const sceneJsonPath = `modules/${MODULE_ID}/catalog/scenes/${slug}.json`;
  const previewRelPath = `modules/${MODULE_ID}/catalog/${PREVIEW_FOLDER_NAME}/${slug}.webp`;
  const previewAbsPath = path.join(outputRoot, PREVIEW_FOLDER_NAME, `${slug}.webp`);
  const preview = await copyPreview(scene.thumb, mappedBackground, worldRoot, assetsRoot, previewAbsPath);
  const sceneEmbedded = embedded.get(scene._id) ?? new Map();

  const sceneData = normalizeScene(scene, mappedBackground, folderPath, sceneEmbedded);
  await fs.writeFile(
    path.join(outputRoot, "scenes", `${slug}.json`),
    JSON.stringify(sceneData),
    "utf8"
  );

  entries.push({
    id: slug,
    name: scene.name,
    variants: inferVariants(scene.name),
    folderPath,
    preview: preview ? previewRelPath.replace(/\\/gu, "/") : null,
    scene: sceneJsonPath.replace(/\\/gu, "/"),
    background: mappedBackground,
    thumb: preview ? previewRelPath.replace(/\\/gu, "/") : mappedBackground,
    width: sceneData.width,
    height: sceneData.height,
    grid: sceneData.grid,
    hasWalls: sceneData.walls.length > 0,
    hasLights: sceneData.lights.length > 0,
    hasDrawings: sceneData.drawings.length > 0,
    hasNotes: sceneData.notes.length > 0
  });
}

entries.sort((left, right) => {
  const folderCompare = (left.folderPath ?? []).join("/").localeCompare((right.folderPath ?? []).join("/"));
  return folderCompare || left.name.localeCompare(right.name);
});

const index = {
  version: 1,
  generatedAt: new Date().toISOString(),
  entries
};

await fs.writeFile(path.join(outputRoot, "index.json"), `${JSON.stringify(index, null, 2)}\n`, "utf8");
console.log(`Catalogo gerado com ${entries.length} cena(s).`);

async function readFolders(dbPath) {
  const db = new Level(dbPath, { valueEncoding: "utf8" });
  const folders = new Map();
  try {
    await db.open();
    for await (const [key, value] of db.iterator()) {
      if (!String(key).startsWith("!folders!")) continue;
      const folder = JSON.parse(value);
      if (folder?.type === "Scene") folders.set(folder._id, folder);
    }
  } finally {
    await db.close();
  }
  return folders;
}

async function readScenes(dbPath) {
  const db = new Level(dbPath, { valueEncoding: "utf8" });
  const scenes = new Map();
  const embedded = new Map();
  try {
    await db.open();
    for await (const [key, value] of db.iterator()) {
      const keyText = String(key);
      if (keyText.startsWith("!scenes!")) {
        if (keyText.includes(".") && !keyText.endsWith("!")) continue;
        const scene = JSON.parse(value);
        if (scene?.background?.src) scenes.set(scene._id, scene);
        continue;
      }

      const match = keyText.match(/^!scenes\.([^!]+)!([^.]+)\.(.+)$/u);
      if (!match) continue;
      const [, type, sceneId] = match;
      if (!EMBEDDED_TYPES.has(type)) continue;

      const perScene = embedded.get(sceneId) ?? new Map();
      const docs = perScene.get(type) ?? [];
      docs.push(JSON.parse(value));
      perScene.set(type, docs);
      embedded.set(sceneId, perScene);
    }
  } finally {
    await db.close();
  }
  return { scenes, embedded };
}

function resolveFolderPath(folderId, folders) {
  const parts = [];
  let currentId = folderId;
  while (currentId && folders.has(currentId)) {
    const folder = folders.get(currentId);
    parts.unshift(folder.name);
    currentId = folder.folder ?? null;
  }
  return parts;
}

function mapBackground(src) {
  const normalized = normalizePath(src);
  if (normalized.startsWith("Mapitas/")) return normalized;
  const cloudPrefix = "moulinette-v2/cloud/";
  if (normalized.startsWith(cloudPrefix)) return `Mapitas/${normalized.slice(cloudPrefix.length)}`;
  return null;
}

function normalizeScene(scene, backgroundSrc, folderPath, embedded) {
  const normalized = {
    id: scene._id,
    name: scene.name,
    folderPath,
    background: {
      ...(scene.background ?? {}),
      src: backgroundSrc
    },
    width: scene.width ?? scene.background?.width ?? 4000,
    height: scene.height ?? scene.background?.height ?? 3000,
    grid: clone(scene.grid ?? null)
  };

  if (scene.padding) normalized.padding = scene.padding;
  if (scene.initial && Object.keys(scene.initial).length) normalized.initial = clone(scene.initial);
  if (scene.tokenVision) normalized.tokenVision = true;

  const fog = clone(scene.fog ?? {});
  if (!isDefaultFog(fog) && Object.keys(fog).length) normalized.fog = fog;

  const environment = clone(scene.environment ?? {});
  if (Object.keys(environment).length) normalized.environment = environment;

  if (scene.foreground) normalized.foreground = clone(scene.foreground);
  if (scene.foregroundElevation != null) normalized.foregroundElevation = scene.foregroundElevation;
  if (scene.weather) normalized.weather = scene.weather;

  const walls = compactEmbedded(embedded.get("walls") ?? []);
  const lights = compactEmbedded(embedded.get("lights") ?? []);
  const drawings = compactEmbedded(embedded.get("drawings") ?? []);
  const notes = compactEmbedded(embedded.get("notes") ?? []);
  const tiles = compactEmbedded(embedded.get("tiles") ?? []);
  const sounds = compactEmbedded(embedded.get("sounds") ?? []);
  const regions = compactEmbedded(embedded.get("regions") ?? []);

  if (walls.length) normalized.walls = walls;
  if (lights.length) normalized.lights = lights;
  if (drawings.length) normalized.drawings = drawings;
  if (notes.length) normalized.notes = notes;
  if (tiles.length) normalized.tiles = tiles;
  if (sounds.length) normalized.sounds = sounds;
  if (regions.length) normalized.regions = regions;

  return normalized;
}

async function copyPreview(sceneThumb, backgroundPath, worldRootPath, assetsRootPath, previewAbsPath) {
  const assetSource = path.join(assetsRootPath, ...normalizePath(backgroundPath).split("/").slice(1));
  if (await pathExists(assetSource)) {
    try {
      await sharp(assetSource)
        .resize({
          width: 640,
          height: 640,
          fit: "inside",
          withoutEnlargement: true
        })
        .webp({
          quality: 72
        })
        .toFile(previewAbsPath);
      return true;
    } catch {
      // Fall back to existing scene thumbs below.
    }
  }

  const match = normalizePath(sceneThumb).match(/^worlds\/[^/]+\/assets\/scenes\/(.+)$/u);
  if (!match) return false;

  const source = path.join(worldRootPath, "assets", "scenes", match[1]);
  try {
    await sharp(source)
      .trim()
      .resize({
        width: 640,
        height: 640,
        fit: "inside",
        withoutEnlargement: true
      })
      .webp({
        quality: 72
      })
      .toFile(previewAbsPath);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function normalizeFolderPath(folderPath) {
  if (folderPath[0] === "Czepeku" && folderPath[1] === "Moulinette" && folderPath[2] === "Cze and Peku") {
    return ["Czepeku", ...folderPath.slice(3)];
  }
  return folderPath;
}

function inferVariants(name) {
  const variants = [];
  for (const token of String(name ?? "").toLowerCase().split(/[^a-z0-9]+/u)) {
    if (!token) continue;
    if (token === "night") variants.push("Night");
    else if (token === "day") variants.push("Day");
    else if (token === "gridless" || token === "ungridded") variants.push("Gridless");
    else if (token === "gridded" || token === "grid") variants.push("Gridded");
    else if (token === "dawn") variants.push("Dawn");
    else if (token === "dusk") variants.push("Dusk");
    else if (token === "sunrise") variants.push("Sunrise");
    else if (token === "sunset") variants.push("Sunset");
    else if (token === "rain") variants.push("Rain");
    else if (token === "snow") variants.push("Snow");
    else if (token === "storm") variants.push("Storm");
    else if (token === "winter") variants.push("Winter");
  }
  return Array.from(new Set(variants));
}

function titleCase(value) {
  return String(value ?? "")
    .split(/[^a-z0-9]+/iu)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizePath(pathText) {
  return String(pathText ?? "").replace(/\\/gu, "/").replace(/\/+/gu, "/").replace(/\/$/u, "");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function compactEmbedded(documents) {
  return documents.map((document) => compactValue(document));
}

function compactValue(value) {
  if (Array.isArray(value)) return value.map((entry) => compactValue(entry));
  if (!value || typeof value !== "object") return value;

  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "_id") continue;
    if (key === "flags" && (!entry || !Object.keys(entry).length)) continue;
    output[key] = compactValue(entry);
  }
  return output;
}

function isDefaultFog(fog) {
  return JSON.stringify(fog ?? {}) === JSON.stringify({
    exploration: true,
    overlay: null,
    colors: {
      explored: null,
      unexplored: null
    },
    reset: null
  });
}

async function clearDirectory(directoryPath) {
  const entries = await fs.readdir(directoryPath);
  await Promise.all(entries.map((entry) => fs.rm(path.join(directoryPath, entry), { recursive: true, force: true })));
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = args[index + 1] && !args[index + 1].startsWith("--") ? args[++index] : true;
    parsed[key] = value;
  }
  return parsed;
}
