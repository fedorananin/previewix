import {
  AnimationMixer,
  AxesHelper,
  Box3,
  Color,
  DirectionalLight,
  DoubleSide,
  GridHelper,
  Group,
  LoadingManager,
  Mesh,
  MeshStandardMaterial,
  NeutralToneMapping,
  PerspectiveCamera,
  PMREMGenerator,
  Points,
  PointsMaterial,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);

const stage = $('stage');
const canvas = $('view');
/** Where the Draco decoder is, which is fetched only by a model that needs it. */
const assets = document.body.dataset.assets;

/**
 * The glTF extensions three.js implements. A file that requires another one is opened, with a warning that names it.
 * KHR_texture_basisu is here because it is answered for separately, see `loadGltf`.
 */
const GLTF_EXTENSIONS = new Set([
  'KHR_draco_mesh_compression',
  'KHR_lights_punctual',
  'KHR_materials_anisotropy',
  'KHR_materials_clearcoat',
  'KHR_materials_dispersion',
  'KHR_materials_emissive_strength',
  'KHR_materials_ior',
  'KHR_materials_iridescence',
  'KHR_materials_sheen',
  'KHR_materials_specular',
  'KHR_materials_transmission',
  'KHR_materials_unlit',
  'KHR_materials_volume',
  'KHR_mesh_quantization',
  'KHR_meshopt_compression',
  'KHR_texture_basisu',
  'KHR_texture_transform',
  'EXT_materials_bump',
  'EXT_mesh_gpu_instancing',
  'EXT_meshopt_compression',
  'EXT_texture_avif',
  'EXT_texture_webp',
]);

/** From where a model is looked at when it opens: the front, a little from the right and from above. */
const HOME = new Vector3(0.55, 0.4, 1).normalize();
const VIEWS = { front: new Vector3(0, 0, 1), side: new Vector3(1, 0, 0), top: new Vector3(0, 1, 0) };
/** Longest side of a saved PNG, when the graphics card doesn't set a lower one. */
const MAX_EXPORT = 8192;

const NO_WEBGL = 'WebGL is not available, so the model cannot be drawn. Hardware acceleration may be turned off in VS Code.';
const CONTEXT_LOST = 'The graphics context was lost. The model comes back when the system restores it.';

/** A reason written for the user, as opposed to an error out of a loader. */
class Problem extends Error {}

// ---- State ----------------------------------------------------------------

const saved = vscode.getState() || {};
const state = {
  /** Position and target once the user has moved the camera; until then the model keeps being framed. */
  camera: [saved.camera?.position, saved.camera?.target].every((v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite)) ? saved.camera : null,
  /** 'y' or 'z' once chosen; until then the format decides. */
  up: saved.up ?? null,
  wireframe: !!saved.wireframe,
  grid: saved.grid !== false,
  axes: !!saved.axes,
  background: ['editor', 'light', 'dark', 'checker'].includes(saved.background) ? saved.background : 'editor',
  info: !!saved.info,
  clip: saved.clip || 0,
};
const saveState = () => vscode.setState(state);

/** What is on screen: `{root, ext, format, unit, about, clips, problems, box}`; `about` is what a glTF says of itself. */
let model = null;
/** Bumped by every load, so that a slower, older one is dropped when it finishes. */
let latest = 0;
let sections = [];

// ---- Helpers --------------------------------------------------------------

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const count = (n) => n.toLocaleString('en-US');
const plural = (n, one, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`;
/** Lengths are shown with four significant digits, without the noise of float arithmetic. */
const tidy = (n) => (n === 0 ? '0' : String(Number(n.toPrecision(4))));

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kb = bytes / 1024;
  return kb < 1024 ? `${kb.toFixed(kb < 10 ? 1 : 0)} KB` : `${(kb / 1024).toFixed(2)} MB`;
}

function formatTime(seconds) {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}.${String(Math.floor((seconds - whole) * 100)).padStart(2, '0')}`;
}

let toastTimer;
function toast(text) {
  $('toast').textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('toast').textContent = ''), 5000);
}

function showMessage(text) {
  $('message').textContent = text;
  $('message').hidden = !text;
}

/** A file that can't be shown: the reason is laid over the stage, and the last good model stays, dimmed. */
function showError(text) {
  $('error').textContent = text;
  $('error').hidden = false;
  showMessage('');
  stage.classList.add('broken');
}

// ---- Scene ----------------------------------------------------------------

const scene = new Scene();
const camera = new PerspectiveCamera(40, 1, 0.1, 100);
// A light that travels with the camera gives every surface some shape, whichever way the model is turned.
const headlight = new DirectionalLight(0xffffff, 1.6);
headlight.position.set(0.4, 0.6, 1);
headlight.target.position.set(0, 0, -1);
camera.add(headlight, headlight.target);
scene.add(camera);
/** Turns a Z-up file onto the Y-up ground of the scene. The axes are inside it, so they are the file's own. */
const tilt = new Group();
scene.add(tilt);

/** Null when WebGL is not to be had; the details are still read and shown then. */
let renderer = null;
let controls = null;
let contextLost = false;
let environment = null;
let grid = null;
let axes = null;
/** The model as it stands in the scene, which is what the camera is set by: its box, the centre and the half diagonal. */
const bounds = new Box3();
const centre = new Vector3();
let radius = 1;

try {
  // The canvas is transparent so that the checkerboard of the stage shows through it.
  renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.toneMapping = NeutralToneMapping;
  renderer.setClearColor(0x000000, 0);
} catch {
  renderer = null;
}

/**
 * Physically based materials show mostly what they reflect, so without surroundings a glTF model comes up black.
 * The surroundings are a small lit room that three.js builds itself, blurred into an environment map.
 */
function makeEnvironment() {
  const generator = new PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  environment?.dispose();
  environment = generator.fromScene(room, 0.04);
  scene.environment = environment.texture;
  // The room is bright enough to wash colours out; at this level a white surface stays just under white.
  scene.environmentIntensity = 0.5;
  room.dispose();
  generator.dispose();
}

// Nothing is drawn unless something changed: a model that just sits there costs no GPU time.
let scheduled = 0;
function requestRender() {
  if (!scheduled && renderer && !contextLost) {
    scheduled = requestAnimationFrame(draw);
  }
}

function draw(now) {
  scheduled = 0;
  if (playing && action) {
    // A tab that was in the background comes back with a long gap, which must not become a jump.
    mixer.update(Math.min((now - lastFrame) / 1000, 0.1));
    lastFrame = now;
    updatePlayer();
    requestRender();
  }
  renderer.render(scene, camera);
}

/** The colour behind the model, taken from the stage's own style so that the theme decides it in one place. */
function backgroundColor() {
  const match = /rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(getComputedStyle(stage).backgroundColor);
  return match ? new Color().setRGB(match[1] / 255, match[2] / 255, match[3] / 255, SRGBColorSpace) : new Color(0x1e1e1e);
}

function applyBackground() {
  stage.dataset.background = state.background;
  $('background').value = state.background;
  const color = backgroundColor();
  // On the checkerboard nothing is painted behind the model, and a saved PNG is transparent there.
  scene.background = state.background === 'checker' ? null : color;
  if (grid) {
    const light = state.background === 'checker' || color.getHSL({}).l > 0.5;
    grid.material.color.set(light ? 0x000000 : 0xffffff);
    grid.material.opacity = light ? 0.22 : 0.16;
  }
  requestRender();
}

function resize() {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  if (!renderer || !w || !h) {
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (model && !state.camera) {
    frame(HOME);
  }
  updateExport();
  requestRender();
}

// ---- Camera ---------------------------------------------------------------

/** The depth range follows the camera, so that models of a millimetre and of a kilometre are both drawn cleanly. */
function updateRange() {
  const distance = camera.position.distanceTo(centre);
  camera.near = Math.max((distance - radius) * 0.5, radius / 1000);
  // The grid reaches further out than the model does.
  camera.far = distance + radius * 8;
  camera.updateProjectionMatrix();
}

/**
 * Puts the camera where the whole model is in view, looking from `direction`. The distance is the one at which
 * the corners of the bounding box just fit, which fills the window far better than fitting a sphere around it.
 */
function frame(direction) {
  if (!controls) {
    return;
  }
  // Looking straight down has no "up" to turn around; a hair off the axis keeps the controls steady.
  const from = Math.abs(direction.y) > 0.9999 ? new Vector3(0, direction.y, 1e-4).normalize() : direction;
  const right = new Vector3().crossVectors(new Vector3(0, 1, 0), from).normalize();
  const up = new Vector3().crossVectors(from, right);
  const tanV = Math.tan((camera.fov * Math.PI) / 360);
  const tanH = tanV * camera.aspect;
  const corner = new Vector3();
  let distance = 0;
  for (let i = 0; i < 8; i++) {
    corner.set(i & 1 ? bounds.max.x : bounds.min.x, i & 2 ? bounds.max.y : bounds.min.y, i & 4 ? bounds.max.z : bounds.min.z).sub(centre);
    distance = Math.max(distance, corner.dot(from) + Math.max(Math.abs(corner.dot(right)) / tanH, Math.abs(corner.dot(up)) / tanV));
  }
  controls.target.copy(centre);
  camera.position.copy(centre).addScaledVector(from, (distance || radius) * 1.12);
  controls.update();
  updateRange();
  requestRender();
}

function resetView() {
  state.camera = null;
  saveState();
  frame(HOME);
}

function setView(name, opposite) {
  if (!model || !controls) {
    return;
  }
  frame(VIEWS[name].clone().multiplyScalar(opposite ? -1 : 1));
  rememberCamera();
}

function rememberCamera() {
  state.camera = { position: camera.position.toArray(), target: controls.target.toArray() };
  saveState();
}

if (renderer) {
  makeEnvironment();
  controls = new OrbitControls(camera, canvas);
  controls.zoomToCursor = true;
  controls.addEventListener('change', () => {
    updateRange();
    requestRender();
  });
  controls.addEventListener('end', rememberCamera);
  canvas.addEventListener('dblclick', resetView);

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    contextLost = true;
    showMessage(CONTEXT_LOST);
  });
  canvas.addEventListener('webglcontextrestored', () => {
    contextLost = false;
    // Everything on the GPU is gone; three.js uploads the model again by itself, the environment has to be redrawn.
    makeEnvironment();
    showMessage('');
    requestRender();
  });
}

new ResizeObserver(resize).observe(stage);
// A switch of the colour theme changes the editor background, which the scene repeats.
new MutationObserver(applyBackground).observe(document.body, { attributes: true, attributeFilter: ['class'] });

// ---- Loading --------------------------------------------------------------

/** The message of an error out of three.js, without the name of the class that raised it. */
function reason(error) {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return text.replace(/^THREE\.\w+: ?/, '') || 'The file is damaged or not in this format.';
}

const latin1 = (bytes) => new TextDecoder('latin1').decode(bytes);

/**
 * What a load shares with its loaders: the manager through which every outside file is fetched,
 * the files that could not be had, and the notes that end up under "Problems".
 */
function loadContext(msg) {
  const src = msg.src.split('?')[0];
  const base = src.slice(0, src.lastIndexOf('/') + 1);
  const failed = [];
  const manager = new LoadingManager();
  manager.onError = (url) => failed.push(url);

  let pending = 0;
  let waiters = [];
  const { itemStart, itemEnd } = manager;
  manager.itemStart = (url) => {
    pending++;
    itemStart(url);
  };
  manager.itemEnd = (url) => {
    itemEnd(url);
    if (--pending === 0) {
      waiters.splice(0).forEach((resolve) => resolve());
    }
  };

  const resolve = (url) => {
    if (/^(blob|data):/i.test(url)) {
      return url;
    }
    if (url.startsWith(base)) {
      // Paths written on Windows: backslashes, and absolute ones, of which only the file name can be right here.
      let rest = url.slice(base.length).replace(/\\/g, '/').replace(/#/g, '%23');
      if (/^[a-z]:\//i.test(rest)) {
        rest = rest.slice(rest.lastIndexOf('/') + 1);
      }
      // The stamp of a reload keeps a rewritten file from being served out of the cache.
      url = base + rest + (msg.stamp ? `${rest.includes('?') ? '&' : '?'}t=${msg.stamp}` : '');
    }
    return url;
  };
  manager.setURLModifier(resolve);

  /** How a file that failed is named to the user: as the model names it. */
  const nameOf = (url) => {
    if (/^(blob|data):/i.test(url)) {
      return 'an embedded image';
    }
    const rest = url.replace(/[?&]t=\d+$/, '');
    try {
      return rest.startsWith(base) ? decodeURIComponent(rest.slice(base.length)) : rest;
    } catch {
      return rest;
    }
  };
  /** What went wrong with outside files, one line per kind of trouble. */
  const missing = () => {
    const names = [...new Set(failed.map(nameOf))];
    const remote = names.filter((name) => /^https?:/i.test(name));
    const local = names.filter((name) => !remote.includes(name));
    const lines = [];
    if (local.length) {
      lines.push(`Could not be loaded: ${local.join(', ')}`);
    }
    if (local.some((name) => name.startsWith('../'))) {
      lines.push('Files above the model\'s own folder are read only when they are inside the workspace folder.');
    }
    if (remote.length) {
      lines.push(`Not loaded, because Previewix fetches nothing from the network: ${remote.join(', ')}`);
    }
    return lines;
  };

  const problems = [];
  return {
    base,
    manager,
    resolve,
    ext: msg.ext,
    problems,
    /** A note for "Problems", said once however many times its cause turns up. */
    note: (text) => void (problems.includes(text) || problems.push(text)),
    textLimit: msg.textLimit,
    /** Resolves when no outside file is on its way any more. */
    settled: () => (pending ? new Promise((done) => waiters.push(done)) : Promise.resolve()),
    missing,
  };
}

function tooLongAsText(buffer, ctx) {
  if (buffer.byteLength > ctx.textLimit) {
    throw new Problem(`This is a text file of ${formatBytes(buffer.byteLength)}. Previewix reads models written as text up to ${formatBytes(ctx.textLimit)}.`);
  }
}

/** What stands in for a material in files that have none: a matt light grey that shows the form. */
function plainMaterial(geometry) {
  return new MeshStandardMaterial({
    color: geometry?.hasAttribute('color') ? 0xffffff : 0xb9bec4,
    roughness: 0.6,
    metalness: 0,
    vertexColors: !!geometry?.hasAttribute('color'),
    // Scans and exports often have faces that look the wrong way; they are not left as holes.
    side: DoubleSide,
  });
}

function meshOrPoints(geometry) {
  // Without faces a file is a point cloud.
  if (!geometry.index && geometry.userData.pointsOnly) {
    return new Points(geometry, new PointsMaterial({ size: 2, sizeAttenuation: false, color: geometry.hasAttribute('color') ? 0xffffff : 0x9aa0a6, vertexColors: geometry.hasAttribute('color') }));
  }
  if (!geometry.hasAttribute('normal')) {
    geometry.computeVertexNormals();
  }
  return new Mesh(geometry, plainMaterial(geometry));
}

/** The JSON of a .gltf or a .glb, read apart from the loader to explain why the loader gave up. */
function gltfJson(buffer) {
  try {
    let bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    if (buffer.byteLength >= 20 && view.getUint32(0, true) === 0x46546c67) {
      bytes = bytes.subarray(20, 20 + view.getUint32(12, true));
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

const unsupported = (json) => (json?.extensionsRequired ?? []).filter((name) => !GLTF_EXTENSIONS.has(name));

async function loadGltf(buffer, ctx) {
  const binary = buffer.byteLength >= 12 && new DataView(buffer).getUint32(0, true) === 0x46546c67;
  if (binary) {
    const announced = new DataView(buffer).getUint32(8, true);
    if (announced > buffer.byteLength) {
      throw new Problem(`The file is cut short: its header announces ${formatBytes(announced)}, and ${formatBytes(buffer.byteLength)} are there.`);
    }
  }
  const loader = new GLTFLoader(ctx.manager);
  const draco = new DRACOLoader(ctx.manager).setDecoderPath({ js: `${assets}draco/draco_wasm_wrapper.js`, wasm: `${assets}draco/draco_decoder.wasm` });
  loader.setDRACOLoader(draco);
  loader.setMeshoptDecoder(MeshoptDecoder);
  // KTX2 textures are left out: the Basis transcoder's glue code builds functions from strings, which the
  // page's policy forbids. Such a texture is skipped and named, unless the file carries a plain picture as well.
  loader.register((parser) => ({
    name: 'KHR_texture_basisu',
    loadTexture(index) {
      const texture = parser.json.textures[index];
      if (!texture.extensions?.KHR_texture_basisu || texture.source !== undefined) {
        return null;
      }
      ctx.note('KTX2 (Basis Universal) textures are not supported, so the model is shown without them');
      return Promise.resolve(null);
    },
  }));
  let gltf;
  try {
    gltf = await loader.parseAsync(buffer, ctx.base);
  } catch (e) {
    const json = gltfJson(buffer);
    if (!json) {
      if (binary) {
        throw new Problem('The file is damaged: the JSON part of this GLB container cannot be read.');
      }
      if (ctx.ext === 'glb' || new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 4096)).includes(0)) {
        throw new Problem('This is not a glTF model: the file is neither a GLB container nor JSON.');
      }
      throw new Problem(`This .gltf file is not valid JSON.\n${reason(e)}`);
    }
    const lacking = unsupported(json);
    if (lacking.length) {
      throw new Problem(`This model requires glTF extensions that Previewix does not support: ${lacking.join(', ')}.`);
    }
    if (json && !json.asset) {
      throw new Problem('This is JSON, but not a glTF model: it has no "asset" entry.');
    }
    if (json?.asset && parseFloat(json.asset.version) < 2) {
      throw new Problem(`This is glTF ${json.asset.version}. Previewix opens glTF 2.0.`);
    }
    throw e;
  } finally {
    // The decoder runs in workers, which would otherwise stay around for as long as the tab does.
    draco.dispose();
  }
  const json = gltf.parser.json;
  const lacking = unsupported(json);
  if (lacking.length) {
    ctx.note(`Requires glTF extensions that Previewix does not support, so it may look wrong: ${lacking.join(', ')}`);
  }
  const root = gltf.scene ?? gltf.scenes[0];
  if (!root) {
    throw new Problem('This glTF file has no scene to show.');
  }
  root.traverse((object) => {
    // Bones move a skinned mesh out of the bounds of its rest pose, by which it would be culled.
    if (object.isSkinnedMesh) {
      object.frustumCulled = false;
    }
  });
  // Only what the details show is kept: the JSON itself may hold megabytes of embedded buffers.
  const size = (list) => list?.length ?? 0;
  const about = {
    asset: json.asset ?? {},
    extensionsUsed: json.extensionsUsed ?? [],
    extensionsRequired: json.extensionsRequired ?? [],
    meshes: size(json.meshes),
    counts: [['Nodes', size(json.nodes)], ['Scenes', size(json.scenes) > 1 ? size(json.scenes) : 0], ['Skins', size(json.skins)], ['Cameras', size(json.cameras)], ['Lights', size(json.extensions?.KHR_lights_punctual?.lights)]],
  };
  return { root, format: `glTF ${about.asset.version ?? '2.0'} (${binary ? 'binary' : 'JSON'})`, unit: ' m', about, clips: gltf.animations };
}

/** Shininess of the Phong model as the roughness of the physically based one (Blinn-Phong to Beckmann). */
const roughnessOf = (shininess) => clamp(Math.sqrt(2 / (Math.max(shininess, 0) + 2)), 0.08, 1);

async function loadObj(buffer, ctx) {
  const bytes = new Uint8Array(buffer);
  if (bytes.subarray(0, 4096).includes(0)) {
    throw new Problem('This is not a Wavefront OBJ model. The extension is also used for compiled object code, which has nothing to show.');
  }
  const text = new TextDecoder().decode(bytes);

  // Materials are in separate .mtl files, which in turn name the textures.
  const libraries = [...text.matchAll(/^[ \t]*mtllib[ \t]+(.+?)[ \t]*$/gm)].map((match) => match[1]);
  let creator = null;
  for (const library of new Set(libraries)) {
    try {
      const response = await fetch(ctx.resolve(ctx.base + library));
      if (!response.ok) {
        throw new Error(String(response.status));
      }
      const next = new MTLLoader(ctx.manager).parse(await response.text(), ctx.base);
      if (creator) {
        Object.assign(creator.materialsInfo, next.materialsInfo);
      } else {
        creator = next;
      }
    } catch {
      ctx.note(`Material file not found: ${library}`);
    }
  }
  const known = new Set(Object.keys(creator?.materialsInfo ?? {}));
  creator?.preload();
  const loader = new OBJLoader(ctx.manager);
  if (creator) {
    loader.setMaterials(creator);
  }
  const root = loader.parse(text);
  await ctx.settled();

  // The loader makes Phong materials, which take no light from the environment. They are rebuilt as
  // physically based ones, so that an OBJ is lit the same way as everything else.
  const converted = new Map();
  const convert = (material, geometry) => {
    if (!material.isMeshPhongMaterial) {
      return material;
    }
    if (!converted.has(material)) {
      let next;
      if (known.has(material.name)) {
        next = new MeshStandardMaterial({
          name: material.name,
          color: material.color,
          emissive: material.emissive,
          opacity: material.opacity,
          transparent: material.transparent,
          vertexColors: material.vertexColors,
          flatShading: material.flatShading,
          roughness: roughnessOf(material.shininess),
          metalness: 0,
          side: DoubleSide,
        });
        for (const slot of ['map', 'emissiveMap', 'normalMap', 'bumpMap', 'alphaMap']) {
          // A texture that didn't arrive would be drawn as black; the material's own colour is the better stand-in.
          if (material[slot]?.image) {
            next[slot] = material[slot];
          } else {
            material[slot]?.dispose();
          }
        }
        next.bumpScale = material.bumpScale;
        next.normalScale.copy(material.normalScale);
      } else {
        next = plainMaterial(geometry);
        next.name = material.name;
        next.flatShading = material.flatShading;
      }
      material.dispose();
      converted.set(material, next);
    }
    return converted.get(material);
  };
  root.traverse((object) => {
    if (object.isMesh) {
      object.material = Array.isArray(object.material) ? object.material.map((m) => convert(m, object.geometry)) : convert(object.material, object.geometry);
    }
  });
  const unknown = [...converted.values()].filter((material) => material.name && !known.has(material.name)).map((material) => material.name);
  if (creator && unknown.length) {
    ctx.note(`Materials used but not defined: ${unknown.join(', ')}`);
  }
  return { root, format: 'Wavefront OBJ', unit: '' };
}

function loadStl(buffer, ctx) {
  const bytes = new Uint8Array(buffer);
  const announced = buffer.byteLength >= 84 ? new DataView(buffer).getUint32(80, true) : 0;
  const exact = buffer.byteLength >= 84 && 84 + announced * 50 === buffer.byteLength;
  // A text STL starts with "solid", but so does the header of many a binary one.
  const text = !exact && /^\s*solid\b/.test(latin1(bytes.subarray(0, 512))) && !bytes.subarray(0, 512).includes(0);
  if (text) {
    tooLongAsText(buffer, ctx);
    // The loader reads a binary header first, and fails on a text that is shorter than one.
    if (buffer.byteLength < 84) {
      throw new Problem('No triangles were found in this STL file.');
    }
  } else if (!exact) {
    if (buffer.byteLength < 84) {
      throw new Problem('The file is too short to be an STL model.');
    }
    // Draws the triangles that are there. The count is corrected in a copy; the file is never written to.
    const present = Math.min(announced, Math.floor((buffer.byteLength - 84) / 50));
    if (present < announced) {
      ctx.note(`The file is cut short: its header announces ${plural(announced, 'triangle')}, and ${count(present)} are there`);
    }
    buffer = buffer.slice(0, 84 + present * 50);
    new DataView(buffer).setUint32(80, present, true);
  }
  const geometry = new STLLoader().parse(buffer);
  if (!geometry.getAttribute('position')?.count) {
    throw new Problem('No triangles were found in this STL file.');
  }
  const mesh = new Mesh(geometry, plainMaterial(geometry));
  if (geometry.hasColors && geometry.alpha < 1) {
    mesh.material.opacity = geometry.alpha;
    mesh.material.transparent = true;
  }
  const root = new Group();
  root.add(mesh);
  return { root, format: `STL (${text ? 'text' : 'binary'})`, unit: '' };
}

function loadPly(buffer, ctx) {
  const head = latin1(new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 4096)));
  if (!/^ply\r?\n/.test(head)) {
    throw new Problem('This is not a PLY model: the file does not start with "ply".');
  }
  const flavour = /^format[ \t]+(\S+)/m.exec(head)?.[1] ?? '';
  if (flavour === 'ascii') {
    tooLongAsText(buffer, ctx);
  }
  const hasFaces = /^element[ \t]+face[ \t]+[1-9]/m.test(head);
  const geometry = new PLYLoader().parse(buffer);
  if (!geometry.getAttribute('position')?.count) {
    throw new Problem('No points were found in this PLY file.');
  }
  geometry.userData.pointsOnly = !hasFaces;
  const root = new Group();
  root.add(meshOrPoints(geometry));
  const names = { ascii: 'text', binary_little_endian: 'binary', binary_big_endian: 'binary, big-endian' };
  return { root, format: `PLY (${names[flavour] ?? flavour})`, unit: '' };
}

const LOADERS = { gltf: loadGltf, glb: loadGltf, obj: loadObj, stl: loadStl, ply: loadPly };

function eachMaterial(root, visit) {
  const seen = new Set();
  root.traverse((object) => {
    for (const material of object.material ? [object.material].flat() : []) {
      if (!seen.has(material)) {
        seen.add(material);
        visit(material);
      }
    }
  });
  return seen;
}

const texturesOf = (material) => Object.values(material).filter((value) => value?.isTexture);

/** Hands back everything a model holds on the GPU; three.js frees nothing by itself. */
function dispose(root) {
  root.traverse((object) => {
    object.geometry?.dispose();
    object.skeleton?.dispose();
  });
  for (const material of eachMaterial(root, () => undefined)) {
    for (const texture of texturesOf(material)) {
      texture.dispose();
      // glTF textures are bitmaps, which hold their memory until they are closed.
      texture.image?.close?.();
    }
    material.dispose();
  }
}

async function load(msg) {
  const mine = ++latest;
  const ctx = loadContext(msg);
  if (!model) {
    showMessage('Loading…');
  }
  let next;
  try {
    const response = await fetch(ctx.resolve(msg.src));
    if (!response.ok) {
      throw new Problem(`Could not read the file (${response.status}).`);
    }
    const buffer = await response.arrayBuffer();
    if (mine !== latest) {
      return;
    }
    if (!buffer.byteLength) {
      throw new Problem('The file is empty.');
    }
    next = await LOADERS[msg.ext](buffer, ctx);
    await ctx.settled();
    next.root.updateMatrixWorld(true);
    next.box = new Box3().setFromObject(next.root);
    if (next.box.isEmpty()) {
      throw new Problem('There is nothing to show: the file has no meshes, lines or points.');
    }
    if (![...next.box.min.toArray(), ...next.box.max.toArray()].every(Number.isFinite)) {
      throw new Problem('The coordinates in this file are not finite numbers.');
    }
  } catch (e) {
    if (next) {
      dispose(next.root);
    }
    if (mine === latest) {
      showError([e instanceof Problem ? e.message : `This model could not be opened.\n${reason(e)}`, ...ctx.missing()].join('\n'));
      $('statInfo').textContent = formatBytes(msg.size);
    }
    return;
  }
  if (mine !== latest) {
    dispose(next.root);
    return;
  }
  next.problems = [...ctx.problems, ...ctx.missing()];
  next.ext = msg.ext;
  next.clips ??= [];
  show(next, msg);
}

/** Swaps the model in. The camera, the toggles and the place in the animation carry over from the one before. */
function show(next, msg) {
  const time = action ? action.time : 0;
  if (model) {
    mixer?.stopAllAction();
    tilt.remove(model.root);
    dispose(model.root);
  }
  model = next;
  tilt.add(model.root);
  mixer = model.clips.length ? new AnimationMixer(model.root) : null;
  action = null;

  $('error').hidden = true;
  stage.classList.remove('broken');
  showMessage(!renderer ? NO_WEBGL : contextLost ? CONTEXT_LOST : '');
  $('noticeText').textContent = model.problems.join('\n');
  $('notice').hidden = !model.problems.length;

  setWireframe(state.wireframe);
  place();
  setupPlayer(time);
  describe(msg);
  setEnabled(!!renderer);
  requestRender();
}

/** Stands the model up, measures it as it stands, and fits the grid, the axes and the camera to it. */
function place() {
  const up = state.up ?? (model.ext === 'stl' ? 'z' : 'y');
  $('up').value = up;
  tilt.rotation.x = up === 'z' ? -Math.PI / 2 : 0;
  tilt.updateMatrixWorld(true);
  const box = bounds.setFromObject(model.root);
  const size = box.getSize(new Vector3());
  box.getCenter(centre);
  // A single point has no size to go by.
  radius = size.length() / 2 || 1;

  if (grid) {
    scene.remove(grid);
    grid.dispose();
  }
  // Cells of a round size (1, 2 or 5 times a power of ten), some six to a model, on a ground twice as wide as it.
  const extent = Math.max(size.x, size.z) || radius;
  const decade = 10 ** Math.floor(Math.log10(extent / 6));
  const step = decade * ([5, 2, 1].find((m) => m * decade <= extent / 6) ?? 1);
  const cells = 2 * Math.ceil(extent / step);
  grid = new GridHelper(step * cells, cells);
  grid.material.vertexColors = false;
  grid.material.transparent = true;
  grid.material.depthWrite = false;
  // Its lines run through the origin's multiples of the step, so that the grid can be read as a ruler.
  grid.position.set(Math.round(centre.x / step) * step, box.min.y, Math.round(centre.z / step) * step);
  grid.visible = state.grid;
  scene.add(grid);
  $('statGrid').textContent = state.grid ? `Grid ${tidy(step)}${model.unit}` : '';
  $('statGrid').dataset.step = `${tidy(step)}${model.unit}`;

  if (axes) {
    tilt.remove(axes);
    axes.dispose();
  }
  axes = new AxesHelper(radius);
  axes.setColors(0xe5484d, 0x46a758, 0x3e63dd);
  axes.material.depthTest = false;
  axes.renderOrder = 1;
  axes.visible = state.axes;
  tilt.add(axes);

  applyBackground();
  if (controls) {
    controls.minDistance = radius / 500;
    controls.maxDistance = radius * 60;
    if (state.camera) {
      camera.position.fromArray(state.camera.position);
      controls.target.fromArray(state.camera.target);
      controls.update();
      updateRange();
    } else {
      frame(HOME);
    }
  }
}

// ---- Details --------------------------------------------------------------

function describe(msg) {
  let triangles = 0;
  let vertices = 0;
  let meshes = 0;
  let points = 0;
  let lines = 0;
  model.root.traverse((object) => {
    const position = object.geometry?.getAttribute('position');
    if (!position) {
      return;
    }
    const copies = object.isInstancedMesh ? object.count : 1;
    const corners = object.geometry.index ? object.geometry.index.count : position.count;
    vertices += position.count * copies;
    if (object.isMesh) {
      meshes++;
      triangles += Math.floor(corners / 3) * copies;
    } else if (object.isPoints) {
      points += corners;
    } else if (object.isLineSegments) {
      lines += Math.floor(corners / 2);
    } else if (object.isLine) {
      lines += Math.max(corners - 1, 0);
    }
  });
  const materials = [...eachMaterial(model.root, () => undefined)];
  const textures = [...new Set(materials.flatMap(texturesOf))];
  const about = model.about;
  const unit = model.unit;
  // In the file's own axes, whichever of them is shown as up.
  const size = model.box.getSize(new Vector3());
  const triple = (v) => `${tidy(v.x)}, ${tidy(v.y)}, ${tidy(v.z)}`;
  const dimensions = `${tidy(size.x)} × ${tidy(size.y)} × ${tidy(size.z)}${unit}`;

  const file = [
    ['Format', model.format],
    ['Size', formatBytes(msg.size)],
  ];
  if (about) {
    const { asset } = about;
    for (const [label, value] of [['Generator', asset.generator], ['Copyright', asset.copyright], ['Min. version', asset.minVersion]]) {
      if (value) {
        file.push([label, String(value)]);
      }
    }
    if (about.extensionsUsed.length) {
      file.push(['Extensions', about.extensionsUsed.join('\n')]);
    }
    if (about.extensionsRequired.length) {
      file.push(['Required', about.extensionsRequired.join('\n')]);
    }
  }

  const geometry = [];
  if (meshes) {
    geometry.push(['Triangles', count(triangles)]);
  }
  geometry.push(['Vertices', count(vertices)]);
  if (points) {
    geometry.push(['Points', count(points)]);
  }
  if (lines) {
    geometry.push(['Lines', count(lines)]);
  }
  // A glTF mesh is drawn in as many parts as it has materials.
  geometry.push(about ? ['Meshes', `${count(about.meshes)} (${plural(meshes, 'part')})`] : ['Meshes', count(meshes)]);
  for (const [label, number] of about?.counts ?? []) {
    if (number) {
      geometry.push([label, count(number)]);
    }
  }

  sections = [
    { title: 'File', rows: file },
    { title: 'Geometry', rows: geometry },
    { title: 'Bounding box', rows: [['Size', dimensions], ['Min', triple(model.box.min)], ['Max', triple(model.box.max)], ['Centre', triple(model.box.getCenter(new Vector3()))]] },
  ];

  const listed = (title, items, row) => {
    if (items.length) {
      const rows = items.slice(0, 60).map(row);
      if (items.length > rows.length) {
        rows.push(['…', `and ${count(items.length - rows.length)} more`]);
      }
      sections.push({ title: `${title} (${count(items.length)})`, rows });
    }
  };
  listed('Materials', materials, (material, i) => {
    const traits = [material.isMeshBasicMaterial ? 'unlit' : material.isPointsMaterial ? 'points' : material.isLineBasicMaterial ? 'lines' : 'PBR'];
    const maps = texturesOf(material).length;
    if (maps) {
      traits.push(plural(maps, 'texture'));
    }
    if (material.vertexColors) {
      traits.push('vertex colours');
    }
    if (material.transparent) {
      traits.push('transparent');
    }
    if (about && material.side === DoubleSide) {
      traits.push('double-sided');
    }
    return [material.name || `#${i + 1}`, traits.join(', ')];
  });
  listed('Textures', textures, (texture, i) => {
    const image = texture.image ?? {};
    const kind = texture.isCompressedTexture ? ', GPU-compressed' : '';
    return [texture.name || `#${i + 1}`, image.width ? `${image.width} × ${image.height}${kind}` : 'not loaded'];
  });
  listed('Animations', model.clips, (clip, i) => [clip.name || `#${i + 1}`, `${tidy(clip.duration)} s, ${plural(clip.tracks.length, 'channel')}`]);
  if (model.problems.length) {
    sections.push({ title: 'Problems', rows: model.problems.map((text, i) => [String(i + 1), text]) });
  }
  renderInfo();

  const summary = [model.format, formatBytes(msg.size)];
  if (meshes) {
    summary.push(plural(triangles, 'triangle'));
  }
  summary.push(points && !meshes ? plural(points, 'point') : plural(vertices, 'vertex', 'vertices'));
  if (materials.length > 1 || textures.length) {
    summary.push(plural(materials.length, 'material'));
  }
  if (textures.length) {
    summary.push(plural(textures.length, 'texture'));
  }
  if (model.clips.length) {
    summary.push(plural(model.clips.length, 'animation'));
  }
  $('statInfo').textContent = summary.join(' · ');
  $('statSize').textContent = dimensions;
}

function renderInfo() {
  const root = $('sections');
  root.textContent = '';
  for (const section of sections) {
    const title = document.createElement('h3');
    title.textContent = section.title;
    const list = document.createElement('dl');
    for (const [label, value] of section.rows) {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value;
      list.append(dt, dd);
    }
    root.append(title, list);
  }
}

function setInfoOpen(open) {
  state.info = open;
  document.body.classList.toggle('info-open', open);
  $('infoToggle').classList.toggle('active', open);
  $('infoToggle').setAttribute('aria-expanded', String(open));
  saveState();
}
$('infoToggle').addEventListener('click', () => setInfoOpen(!state.info));
$('closeInfo').addEventListener('click', () => setInfoOpen(false));
$('copyInfo').addEventListener('click', () => {
  const text = sections
    .map((s) => `${s.title}\n${s.rows.map(([label, value]) => `  ${label}: ${value.replace(/\n/g, ', ')}`).join('\n')}`)
    .join('\n\n');
  vscode.postMessage({ type: 'copy', text });
});
$('noticeClose').addEventListener('click', () => ($('notice').hidden = true));

// ---- Animation ------------------------------------------------------------

let mixer = null;
let action = null;
let playing = false;
let lastFrame = 0;

function updatePlayer() {
  $('seek').value = String(action.time);
  $('time').textContent = `${formatTime(action.time)} / ${formatTime(action.getClip().duration)}`;
}

function seek(time) {
  action.time = clamp(time, 0, action.getClip().duration);
  // Poses the model at that moment without letting time pass.
  mixer.update(0);
  updatePlayer();
  requestRender();
}

function chooseClip(index, time = 0) {
  mixer.stopAllAction();
  state.clip = index;
  saveState();
  $('clip').value = String(index);
  action = mixer.clipAction(model.clips[index]);
  action.play();
  $('seek').max = String(action.getClip().duration);
  seek(time);
}

function setPlaying(on) {
  playing = on && !!action;
  $('play').classList.toggle('playing', playing);
  lastFrame = performance.now();
  requestRender();
}

/** The clips of a new model. A model without animation has no player, and nothing that keeps drawing. */
function setupPlayer(time) {
  const clips = model.clips;
  $('player').hidden = !clips.length;
  if (!clips.length) {
    setPlaying(false);
    return;
  }
  $('clip').replaceChildren(...clips.map((clip, i) => new Option(clip.name || `Animation ${i + 1}`, String(i))));
  $('clip').hidden = clips.length < 2;
  const index = state.clip < clips.length ? state.clip : 0;
  chooseClip(index, Math.min(time, clips[index].duration));
  setPlaying(playing);
}

$('play').addEventListener('click', () => setPlaying(!playing));
$('clip').addEventListener('change', () => chooseClip(Number($('clip').value)));
$('seek').addEventListener('input', () => seek(Number($('seek').value)));

// ---- Toggles --------------------------------------------------------------

function setWireframe(on) {
  state.wireframe = on;
  $('wireframe').classList.toggle('active', on);
  if (model) {
    eachMaterial(model.root, (material) => {
      if ('wireframe' in material) {
        material.wireframe = on;
      }
    });
  }
  saveState();
  requestRender();
}

function setGrid(on) {
  state.grid = on;
  $('grid').classList.toggle('active', on);
  if (grid) {
    grid.visible = on;
    $('statGrid').textContent = on ? `Grid ${$('statGrid').dataset.step}` : '';
  }
  saveState();
  requestRender();
}

function setAxes(on) {
  state.axes = on;
  $('axes').classList.toggle('active', on);
  if (axes) {
    axes.visible = on;
  }
  saveState();
  requestRender();
}

$('wireframe').addEventListener('click', () => setWireframe(!state.wireframe));
$('grid').addEventListener('click', () => setGrid(!state.grid));
$('axes').addEventListener('click', () => setAxes(!state.axes));
$('reset').addEventListener('click', resetView);
$('viewFront').addEventListener('click', (e) => setView('front', e.shiftKey));
$('viewSide').addEventListener('click', (e) => setView('side', e.shiftKey));
$('viewTop').addEventListener('click', (e) => setView('top', e.shiftKey));
$('background').addEventListener('change', () => {
  state.background = $('background').value;
  saveState();
  applyBackground();
});
$('up').addEventListener('change', () => {
  state.up = $('up').value;
  // The model has been turned over, so a camera that was set for the other way round no longer fits.
  state.camera = null;
  saveState();
  if (model) {
    place();
  }
});
$('openSource')?.addEventListener('click', (e) => vscode.postMessage({ type: 'openSource', beside: e.altKey }));

function setEnabled(on) {
  for (const id of ['reset', 'viewFront', 'viewSide', 'viewTop', 'exportToggle']) {
    $(id).disabled = !on;
  }
  if (!on) {
    toggleExport(false);
  }
}

// ---- Saving a picture -----------------------------------------------------

let exportScale = 1;
let pendingSize = 0;

function toggleExport(show) {
  $('exportPanel').hidden = !show;
  $('exportToggle').classList.toggle('active', show);
  updateExport();
}

/** The pixel size of the saved picture: the view as it is on screen, times the chosen scale. */
function exportSize() {
  const limit = Math.min(MAX_EXPORT, renderer.capabilities.maxTextureSize);
  const scale = Math.min(exportScale, limit / canvas.width, limit / canvas.height);
  return { w: Math.max(1, Math.round(canvas.width * scale)), h: Math.max(1, Math.round(canvas.height * scale)) };
}

function updateExport() {
  if (!renderer || $('exportPanel').hidden) {
    return;
  }
  const { w, h } = exportSize();
  $('outSize').textContent = `${w} × ${h} px`;
  for (const button of document.querySelectorAll('#scales button')) {
    button.classList.toggle('active', Number(button.dataset.scale) === exportScale);
  }
}

for (const button of document.querySelectorAll('#scales button')) {
  button.addEventListener('click', () => {
    exportScale = Number(button.dataset.scale);
    updateExport();
  });
}

function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

$('save').addEventListener('click', async () => {
  if (!model || !renderer || contextLost) {
    return;
  }
  const { w, h } = exportSize();
  try {
    // The view is drawn once more at the size asked for. The drawing buffer is cleared after every frame,
    // so the picture has to be taken in the same turn in which it was drawn.
    renderer.setPixelRatio(1);
    renderer.setSize(w, h, false);
    renderer.render(scene, camera);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((result) => (result ? resolve(result) : reject(new Error('The picture could not be encoded.'))), 'image/png');
    });
    pendingSize = blob.size;
    vscode.postMessage({ type: 'save', data: await toBase64(blob) });
  } catch (err) {
    toast(String(err instanceof Error ? err.message : err));
  } finally {
    resize();
  }
});
$('exportToggle').addEventListener('click', () => toggleExport($('exportPanel').hidden));

// ---- Keys and messages ----------------------------------------------------

document.addEventListener('keydown', (e) => {
  const target = e.target;
  const typing = ['INPUT', 'SELECT'].includes(target.tagName);
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();
  // By position, because Shift turns the digits into punctuation.
  const digit = /^(?:Digit|Numpad)(\d)$/.exec(e.code)?.[1];
  if (mod && key === 's') {
    e.preventDefault();
    if (model && renderer) {
      toggleExport(true);
    }
  } else if (e.key === 'Escape') {
    toggleExport(false);
  } else if (mod || e.altKey) {
    return;
  } else if (key === ' ' && action && target.tagName !== 'SELECT') {
    // Also when a button has the focus, which the space bar would otherwise press.
    e.preventDefault();
    setPlaying(!playing);
  } else if (typing) {
    return;
  } else if (digit === '0') {
    resetView();
  } else if (digit === '1') {
    setView('front', e.shiftKey);
  } else if (digit === '2') {
    setView('side', e.shiftKey);
  } else if (digit === '3') {
    setView('top', e.shiftKey);
  } else if (key === 'w') {
    setWireframe(!state.wireframe);
  } else if (key === 'g') {
    setGrid(!state.grid);
  } else if (key === 'a') {
    setAxes(!state.axes);
  } else if (key === 'i') {
    setInfoOpen(!state.info);
  }
});

window.addEventListener('message', (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'source':
      void load(msg);
      break;
    case 'error':
      // A newer answer than any load still under way.
      latest++;
      showError(msg.message);
      break;
    case 'saved':
      toast(`Saved ${msg.name} (${formatBytes(pendingSize)})`);
      toggleExport(false);
      break;
  }
});

setInfoOpen(state.info);
$('wireframe').classList.toggle('active', state.wireframe);
$('grid').classList.toggle('active', state.grid);
$('axes').classList.toggle('active', state.axes);
applyBackground();
setEnabled(false);
vscode.postMessage({ type: 'ready' });
