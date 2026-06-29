/**
 * SuperSplat Viewer – lightweight, embeddable entry point.
 *
 * This module initialises the PlayCanvas-based 3D Gaussian Splat renderer
 * without any editor UI (no toolbars, panels, selection tools, etc.) so that
 * the resulting page can be served as a standalone viewer and embedded in any
 * website via an <iframe>.
 *
 * URL parameters
 * ──────────────
 * ?load=<url>            – auto-load a splat file on startup (repeatable)
 * ?content=<url>         – alias for ?load= (compatible with official PlayCanvas viewer)
 * ?filename=<name>       – display name override for the nth ?load file
 * ?autorotate=<speed>    – start auto-rotation at the given deg/s (e.g. 20)
 * ?mode=walk             – start in walk (first-person) mode
 * ?poster=<url>          – show a preview image while the splat file loads
 * ?aa                    – enable anti-aliasing
 * ?config.bgClr.r=<0-1>  – scene-config overrides (same dot-notation as editor)
 * ?focal=x,y,z           – initial camera focal point
 * ?angles=azim,elev      – initial camera angles
 * ?distance=<d>          – initial camera distance
 *
 * postMessage API
 * ───────────────
 * See viewer-api.ts for the full list of supported messages.
 */

import './viewer.scss';

import { WebPCodec } from '@playcanvas/splat-transform';
import { Color, Vec3, createGraphicsDevice } from 'playcanvas';

import { CommandQueue } from './command-queue';
import { Events } from './events';
import { Scene } from './scene';
import { getSceneConfig } from './scene-config';
import { WalkController } from './walk-controller';
import { loadSplatFromUrl, postToParent, registerViewerApi } from './viewer-api';

// ---------------------------------------------------------------------------
// config.json types
// ---------------------------------------------------------------------------

interface ProjectViewerOptions {
    background?: string;   // hex colour e.g. '#1a1a2e'
    mode?: 'orbit' | 'walk';
    autorotate?: number;   // deg/s, 0 = disabled
    fov?: number;          // degrees
}

interface ProjectEntry {
    name: string;
    /** Path relative to dist/ – e.g. "data/my-project/model.ply" */
    file: string;
    viewer?: ProjectViewerOptions;
}

interface ViewerConfig {
    activeProject: string;
    projects: Record<string, ProjectEntry>;
}

/** Fetch and parse config.json. Returns null on any failure. */
const loadConfig = async (): Promise<ViewerConfig | null> => {
    try {
        const res = await fetch('./config.json');
        if (!res.ok) return null;
        return (await res.json()) as ViewerConfig;
    } catch {
        return null;
    }
};

// ---------------------------------------------------------------------------
// URL → scene-config override helper (mirrors getURLArgs in main.ts)
// ---------------------------------------------------------------------------

const getURLArgs = (): Record<string, any> => {
    const config: Record<string, any> = {};

    const apply = (key: string, value: string) => {
        let obj: any = config;
        key.split('.').forEach((k, i, a) => {
            if (i === a.length - 1) {
                obj[k] = value;
            } else {
                if (!Object.prototype.hasOwnProperty.call(obj, k)) obj[k] = {};
                obj = obj[k];
            }
        });
    };

    new URLSearchParams(window.location.search.slice(1)).forEach((value, key) => {
        apply(key, value);
    });

    return config;
};

// ---------------------------------------------------------------------------
// Main initialisation
// ---------------------------------------------------------------------------

const initViewer = async () => {
    // Grab the elements defined in viewer.html
    const canvas = document.getElementById('canvas') as HTMLCanvasElement;

    // ── Events ──────────────────────────────────────────────────────────────
    const events = new Events();

    // ── Command queue ────────────────────────────────────────────────────────
    const commandQueue = new CommandQueue();
    events.function('queue', (fn: () => Promise<void> | void) => commandQueue.enqueue(fn));

    // ── WebP WASM codec (needed for .sog / .ssog format support) ────────────
    WebPCodec.wasmUrl = new URL('static/lib/webp/webp.wasm', document.baseURI).toString();

    // ── Scene config (URL param overrides) ──────────────────────────────────
    const sceneConfig = getSceneConfig([getURLArgs()]);

    // ── Graphics device ─────────────────────────────────────────────────────
    const aaEnabled = new URL(window.location.href).searchParams.has('aa');

    const graphicsDevice = await createGraphicsDevice(canvas, {
        deviceTypes: ['webgl2'],
        antialias: aaEnabled,
        depth: false,
        stencil: false,
        xrCompatible: false,
        powerPreference: 'high-performance'
    });

    // ── Scene (rendering + camera) ───────────────────────────────────────────
    const scene = new Scene(events, sceneConfig, canvas, graphicsDevice, commandQueue);

    // ── Background colour ────────────────────────────────────────────────────
    const applyBgColor = (clr: Color) => {
        const ch = (v: number) => Math.max(0, Math.min(255, v * 255)).toFixed(0);
        document.body.style.backgroundColor =
            `rgba(${ch(clr.r)},${ch(clr.g)},${ch(clr.b)},${clr.a.toFixed(3)})`;
    };

    const bgClr = new Color(
        sceneConfig.bgClr.r,
        sceneConfig.bgClr.g,
        sceneConfig.bgClr.b,
        sceneConfig.bgClr.a
    );
    applyBgColor(bgClr);

    events.on('setBgClr', (clr: Color) => {
        bgClr.copy(clr);
        applyBgColor(clr);
    });

    // ── Camera reset (mirrors editor.ts behaviour) ───────────────────────────
    events.on('camera.reset', () => {
        const { initialAzim, initialElev, initialZoom } = sceneConfig.controls;
        const rad = Math.PI / 180;
        const x = Math.sin(initialAzim * rad) * Math.cos(initialElev * rad);
        const y = -Math.sin(initialElev * rad);
        const z = Math.cos(initialAzim * rad) * Math.cos(initialElev * rad);
        scene.camera.setPose(
            new Vec3(x * initialZoom, y * initialZoom, z * initialZoom),
            Vec3.ZERO
        );
        scene.forceRender = true;
    });

    // Force a render whenever the scene bounds change (e.g. after file load)
    events.on('scene.boundChanged', () => {
        scene.forceRender = true;
    });

    // ── camera.setControlMode event (editor.ts not loaded in viewer) ─────────
    // PointerController fires this event when switching between orbit / fly;
    // without a handler the camera.controlMode property never updates.
    events.on('camera.setControlMode', (mode: 'orbit' | 'fly') => {
        scene.camera.controlMode = mode;
    });

    // ── Walk controller ──────────────────────────────────────────────────────
    const walkController = new WalkController(scene, canvas);

    // ── Register postMessage API ─────────────────────────────────────────────
    registerViewerApi(events, scene, walkController);

    // ── Start rendering ──────────────────────────────────────────────────────
    scene.start();

    // ── Signal readiness to parent frame ─────────────────────────────────────
    postToParent({ type: 'supersplat-viewer:ready' });

    // ── Parse URL parameters ─────────────────────────────────────────────────
    // ?content= is an alias for ?load= (compatible with official PlayCanvas viewer)
    const url = new URL(window.location.href);

    // ── Poster (loading preview image) ───────────────────────────────────────
    const posterEl = document.getElementById('poster') as HTMLDivElement;
    const posterImg = document.getElementById('poster-img') as HTMLImageElement;
    const posterUrl = url.searchParams.get('poster');

    const hidePoster = () => {
        if (!posterEl || posterEl.classList.contains('hidden')) return;
        posterEl.classList.add('fading');
        posterEl.addEventListener('transitionend', () => posterEl.classList.add('hidden'), { once: true });
    };

    if (posterUrl && posterEl && posterImg) {
        posterImg.src = decodeURIComponent(posterUrl);
        posterEl.classList.remove('hidden');
        // Hide poster once the first splat loads or on error
        window.addEventListener('message', (e: MessageEvent) => {
            const t = e.data?.type;
            if (t === 'supersplat-viewer:loaded' || t === 'supersplat-viewer:error') {
                hidePoster();
            }
        }, { once: false });
    }

    // ── Load splat files ──────────────────────────────────────────────────────
    const loadList = [
        ...url.searchParams.getAll('load'),
        ...url.searchParams.getAll('content')
    ];
    const filenameList = url.searchParams.getAll('filename');

    // Track effective viewer options (URL params take priority over config.json)
    let effectiveMode = url.searchParams.get('mode') as 'orbit' | 'walk' | null;
    let effectiveAutorotate = url.searchParams.get('autorotate');

    if (loadList.length > 0) {
        // ── Explicit ?load= params ───────────────────────────────────────────
        for (const [i, value] of loadList.entries()) {
            const decoded = decodeURIComponent(value);
            const name = i < filenameList.length
                ? decodeURIComponent(filenameList[i])
                : (decoded.split('/').pop() ?? decoded);

            await loadSplatFromUrl(decoded, name, events, scene);
        }
    } else {
        // ── No ?load= → fall back to config.json ────────────────────────────
        const cfg = await loadConfig();
        if (cfg) {
            const project = cfg.projects[cfg.activeProject];
            if (project?.file) {
                const filename = project.file.split('/').pop() ?? project.file;
                await loadSplatFromUrl(project.file, filename, events, scene);

                // Apply viewer options from config (URL params take priority)
                const vo = project.viewer ?? {};
                if (vo.background) {
                    window.dispatchEvent(new MessageEvent('message', {
                        data: { type: 'supersplat-viewer:set-background', color: vo.background }
                    }));
                }
                if (effectiveMode === null && vo.mode) {
                    effectiveMode = vo.mode;
                }
                if (effectiveAutorotate === null && vo.autorotate) {
                    effectiveAutorotate = String(vo.autorotate);
                }
            } else {
                console.warn(`[supersplat-viewer] config.json: project "${cfg.activeProject}" has no "file" field.`);
            }
        }
    }

    // ── Handle mode (orbit / walk) ────────────────────────────────────────────
    if (effectiveMode === 'walk') {
        walkController.activate();
    }

    // ── Handle autorotate ────────────────────────────────────────────────────
    if (effectiveAutorotate !== null) {
        const speed = parseFloat(effectiveAutorotate);
        window.dispatchEvent(new MessageEvent('message', {
            data: {
                type: 'supersplat-viewer:set-autorotate',
                enabled: true,
                speed: isFinite(speed) ? speed : 20
            }
        }));
    }
};

initViewer().catch((err) => {
    console.error('[supersplat-viewer] init failed:', err);
});
