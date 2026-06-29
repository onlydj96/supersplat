import { Color } from 'playcanvas';

import { Events } from './events';
import { MappedReadFileSystem } from './io';
import { Scene } from './scene';
import { WalkController } from './walk-controller';

// ---------------------------------------------------------------------------
// Message type definitions
// ---------------------------------------------------------------------------

// Messages received from the parent window (parent → iframe)
export interface LoadMessage {
    type: 'supersplat-viewer:load';
    /** Absolute or relative URL to the splat file (.ply, .splat, .sog, .spz, …) */
    url: string;
    /** Optional display name; derived from URL when omitted */
    filename?: string;
}

export interface SetBackgroundMessage {
    type: 'supersplat-viewer:set-background';
    /**
     * CSS-style hex colour string.
     * Formats: '#rrggbb'  |  '#rrggbbaa'  |  'transparent'
     */
    color: string;
}

export interface ResetCameraMessage {
    type: 'supersplat-viewer:reset-camera';
}

export interface FocusMessage {
    type: 'supersplat-viewer:focus';
}

export interface SetAutoRotateMessage {
    type: 'supersplat-viewer:set-autorotate';
    enabled: boolean;
    /** Rotation speed in degrees per second (default: 20) */
    speed?: number;
}

export interface GetInfoMessage {
    type: 'supersplat-viewer:get-info';
}

export interface SetControlModeMessage {
    type: 'supersplat-viewer:set-control-mode';
    /**
     * 'orbit' – default orbit/pan mode.
     * 'walk'  – first-person walk mode with pointer lock (WASD + mouse look).
     */
    mode: 'orbit' | 'walk';
}

export type ViewerInMessage =
    | LoadMessage
    | SetBackgroundMessage
    | ResetCameraMessage
    | FocusMessage
    | SetAutoRotateMessage
    | GetInfoMessage
    | SetControlModeMessage;

// Messages sent to the parent window (iframe → parent)
export interface ReadyMessage {
    type: 'supersplat-viewer:ready';
}

export interface LoadedMessage {
    type: 'supersplat-viewer:loaded';
    url: string;
    filename: string;
    splatCount: number;
}

export interface LoadErrorMessage {
    type: 'supersplat-viewer:error';
    message: string;
}

export interface InfoMessage {
    type: 'supersplat-viewer:info';
    loaded: boolean;
    splatCount: number;
}

export type ViewerOutMessage = ReadyMessage | LoadedMessage | LoadErrorMessage | InfoMessage;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MSG_PREFIX = 'supersplat-viewer:';

/** Send a message to the embedding parent frame (safe when not in iframe). */
export const postToParent = (message: ViewerOutMessage): void => {
    if (window.parent && window.parent !== window) {
        window.parent.postMessage(message, '*');
    }
};

/** Parse '#rrggbb' / '#rrggbbaa' / 'transparent' → PlayCanvas Color. */
const parseColor = (color: string): Color | null => {
    if (color === 'transparent') return new Color(0, 0, 0, 0);

    const hex = color.replace('#', '');
    if (hex.length === 6) {
        return new Color(
            parseInt(hex.slice(0, 2), 16) / 255,
            parseInt(hex.slice(2, 4), 16) / 255,
            parseInt(hex.slice(4, 6), 16) / 255,
            1
        );
    }
    if (hex.length === 8) {
        return new Color(
            parseInt(hex.slice(0, 2), 16) / 255,
            parseInt(hex.slice(2, 4), 16) / 255,
            parseInt(hex.slice(4, 6), 16) / 255,
            parseInt(hex.slice(6, 8), 16) / 255
        );
    }
    return null;
};

// ---------------------------------------------------------------------------
// Splat loader
// ---------------------------------------------------------------------------

/**
 * Load a Gaussian Splat file from a URL, add it to the scene and
 * notify the parent frame when done.
 */
export const loadSplatFromUrl = async (
    url: string,
    filename: string,
    events: Events,
    scene: Scene
): Promise<void> => {
    try {
        // Build a MappedReadFileSystem rooted at the URL's directory so that
        // relative companion files (SOG WebP tiles, etc.) resolve correctly.
        const baseUrl = new URL('.', new URL(url, window.location.href)).href;
        const fileSystem = new MappedReadFileSystem(baseUrl);

        const model = await scene.assetLoader.load(url, fileSystem, false);
        await scene.add(model);

        // Auto-focus camera on newly loaded content
        scene.camera.focus();
        scene.forceRender = true;

        const splatCount: number = (model as any).numSplats ?? 0;
        postToParent({ type: 'supersplat-viewer:loaded', url, filename, splatCount });
    } catch (error: any) {
        const message: string = error?.message ?? String(error);
        console.error('[supersplat-viewer] load error:', message);
        postToParent({ type: 'supersplat-viewer:error', message });
    }
};

// ---------------------------------------------------------------------------
// API registration
// ---------------------------------------------------------------------------

/**
 * Register the postMessage API that lets the embedding page control the viewer.
 *
 * ### Commands (parent → iframe)
 * | `type`                              | payload                        |
 * |-------------------------------------|--------------------------------|
 * | `supersplat-viewer:load`            | `{ url, filename? }`           |
 * | `supersplat-viewer:set-background`  | `{ color }` (hex / transparent)|
 * | `supersplat-viewer:reset-camera`    | —                              |
 * | `supersplat-viewer:focus`           | —                              |
 * | `supersplat-viewer:set-autorotate`  | `{ enabled, speed? }`          |
 * | `supersplat-viewer:get-info`        | —                              |
 * | `supersplat-viewer:set-control-mode`| `{ mode }` ('orbit'/'walk')   |
 *
 * ### Events (iframe → parent)
 * | `type`                              | payload                        |
 * |-------------------------------------|--------------------------------|
 * | `supersplat-viewer:ready`           | —                              |
 * | `supersplat-viewer:loaded`          | `{ url, filename, splatCount }`|
 * | `supersplat-viewer:error`           | `{ message }`                  |
 * | `supersplat-viewer:info`            | `{ loaded, splatCount }`       |
 */
export const registerViewerApi = (
    events: Events,
    scene: Scene,
    walkController?: WalkController
): void => {
    // Auto-rotate state
    let autoRotateEnabled = false;
    let autoRotateSpeed = 20; // deg/s
    let prevTime = 0;

    const autoRotateTick = (time: number) => {
        if (!autoRotateEnabled) return;

        const delta = prevTime ? (time - prevTime) / 1000 : 0;
        prevTime = time;

        scene.camera.setAzimElev(
            scene.camera.azim + autoRotateSpeed * delta,
            scene.camera.elevation,
            0 // instant, no damping
        );
        scene.forceRender = true;
        requestAnimationFrame(autoRotateTick);
    };

    window.addEventListener('message', async (event: MessageEvent) => {
        const data = event.data as ViewerInMessage;

        // Ignore messages not belonging to this API
        if (typeof data?.type !== 'string' || !data.type.startsWith(MSG_PREFIX)) return;

        switch (data.type) {
            case 'supersplat-viewer:load': {
                const { url, filename } = data;
                const name = filename ?? url.split('/').pop() ?? url;
                await loadSplatFromUrl(url, name, events, scene);
                break;
            }

            case 'supersplat-viewer:set-background': {
                const clr = parseColor(data.color);
                if (clr) {
                    events.fire('setBgClr', clr);
                } else {
                    console.warn('[supersplat-viewer] Invalid color:', data.color);
                }
                break;
            }

            case 'supersplat-viewer:reset-camera': {
                events.fire('camera.reset');
                scene.forceRender = true;
                break;
            }

            case 'supersplat-viewer:focus': {
                scene.camera.focus();
                scene.forceRender = true;
                break;
            }

            case 'supersplat-viewer:set-autorotate': {
                autoRotateEnabled = data.enabled;
                if (data.speed !== undefined) autoRotateSpeed = data.speed;

                if (autoRotateEnabled) {
                    prevTime = 0;
                    requestAnimationFrame(autoRotateTick);
                }
                break;
            }

            case 'supersplat-viewer:get-info': {
                const splats = scene.elements.filter(e => (e as any).numSplats !== undefined);
                const splatCount = splats.reduce((acc, s) => acc + ((s as any).numSplats ?? 0), 0);
                postToParent({
                    type: 'supersplat-viewer:info',
                    loaded: splats.length > 0,
                    splatCount
                });
                break;
            }

            case 'supersplat-viewer:set-control-mode': {
                if (!walkController) break;
                if (data.mode === 'walk') {
                    walkController.activate();
                } else {
                    walkController.deactivate();
                }
                break;
            }
        }
    });
};
