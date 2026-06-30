/**
 * WalkController – collision-aware first-person walk mode.
 *
 * Movement is handled entirely in this controller (not delegated to
 * PointerController via camera.fly.* events) so that we can apply
 * floor clamping and wall avoidance before updating the camera position.
 *
 * Physics model (simplified, no full physics engine)
 * ────────────────────────────────────────────────────
 *  • Horizontal (XZ) movement: WASD at a fixed speed.
 *  • Wall avoidance:           forward-direction raycast, step cancelled if
 *                              an obstacle is within WALL_CLEARANCE metres.
 *  • Floor lock:               downward raycast to find the floor surface;
 *                              camera Y is clamped to floorY + eyeHeight.
 *                              Falls back to a fixed floorY when no collision
 *                              mesh is available.
 *  • Gravity:                  if no floor found below, the Y velocity
 *                              accumulates downward (free-fall capped at
 *                              TERMINAL_VELOCITY) until the floor is found.
 *
 * Controls (while active)
 * ─────────────────────────
 *  W / ↑       move forward
 *  S / ↓       move backward
 *  A / ←       strafe left
 *  D / →       strafe right
 *  Shift       move faster (×3)
 *  Alt         move slower (×0.3)
 *  Escape      release pointer lock (click canvas to re-acquire)
 *
 * Configuration (WalkConfig)
 * ─────────────────────────────
 *  collision     ICollisionSystem (GLB or voxel-based, optional)
 *  eyeHeight     metres above the floor surface the camera sits (default 1.6)
 *  floorY        fixed floor height used when no collision mesh is available
 *  speed         base movement speed in m/s (default 3)
 *  startPosition initial camera world position [x, y, z]
 *  startYaw      initial look direction in degrees (0 = +Z)
 */

import { Vec3 } from 'playcanvas';

import { ICollisionSystem } from './collision-system';
import { Scene } from './scene';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum downward raycast distance when searching for the floor (metres). */
const FLOOR_SEARCH_DIST = 20.0;

/** Minimum clearance from a wall before horizontal movement is blocked. */
const WALL_CLEARANCE = 0.35;

/** Additional upward offset when spawning above known floor (prevents clipping). */
const SPAWN_LIFT = 0.05;

/** Free-fall acceleration (m/s²). */
const GRAVITY = 9.8;

/** Maximum downward speed when in free-fall (m/s). */
const TERMINAL_VELOCITY = 20.0;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WalkConfig {
    /** Collision system (GLB-based or voxel-based) used for floor/wall queries. */
    collision?: ICollisionSystem;
    /** Camera eye height above the floor surface in metres (default 1.6). */
    eyeHeight?: number;
    /** Fixed floor Y used when no collision mesh is provided (default 0). */
    floorY?: number;
    /** Base movement speed in metres per second (default 3). */
    speed?: number;
    /** World-space starting position [x, y, z]. */
    startPosition?: [number, number, number];
    /** Initial yaw angle in degrees (0 = forward along +Z). */
    startYaw?: number;
}

// ---------------------------------------------------------------------------
// Scratch vectors (avoid per-frame heap allocation)
// ---------------------------------------------------------------------------
const _fwd    = new Vec3();
const _right  = new Vec3();
const _vel    = new Vec3();
const _pos    = new Vec3();
const _down   = new Vec3(0, -1, 0);

// ---------------------------------------------------------------------------
// WalkController
// ---------------------------------------------------------------------------

export class WalkController {
    private readonly scene: Scene;
    private readonly canvas: HTMLCanvasElement;
    private readonly hint: HTMLElement;

    private _active = false;
    private _config: Required<WalkConfig> = {
        collision:     undefined as unknown as ICollisionSystem,
        eyeHeight:     1.6,
        floorY:        0.0,
        speed:         3.0,
        startPosition: undefined as any,
        startYaw:      0
    };

    /** Vertical velocity in m/s (negative = falling). */
    private _verticalVel = 0;

    private readonly _keys = new Set<string>();

    // Pre-bound handlers
    private readonly _onKeyDown: (e: KeyboardEvent) => void;
    private readonly _onKeyUp: (e: KeyboardEvent) => void;
    private readonly _onMouseMove: (e: MouseEvent) => void;
    private readonly _onPointerLockChange: () => void;
    private readonly _onCanvasClick: () => void;
    private readonly _onDblClick: (e: MouseEvent) => void;
    private readonly _onBlur: () => void;
    private readonly _onUpdate: (dt: number) => void;

    constructor(scene: Scene, canvas: HTMLCanvasElement) {
        this.scene = scene;
        this.canvas = canvas;

        this.hint = document.createElement('div');
        this.hint.id = 'walk-hint';
        this.hint.className = 'walk-hint hidden';
        document.body.appendChild(this.hint);

        this._onKeyDown            = this._handleKeyDown.bind(this);
        this._onKeyUp              = this._handleKeyUp.bind(this);
        this._onMouseMove          = this._handleMouseMove.bind(this);
        this._onPointerLockChange  = this._handlePointerLockChange.bind(this);
        this._onCanvasClick        = this._handleCanvasClick.bind(this);
        this._onDblClick           = this._handleDblClick.bind(this);
        this._onBlur               = this._clearKeys.bind(this);
        this._onUpdate             = this._update.bind(this);
    }

    // ── Public API ──────────────────────────────────────────────────────────

    get active(): boolean { return this._active; }

    get pointerLocked(): boolean {
        return document.pointerLockElement === this.canvas;
    }

    /**
     * (Re-)configure walk physics. Safe to call before or after activate().
     * Call with a collision mesh loaded from a GLB file and the project's
     * walk settings read from config.json.
     */
    configure(config: WalkConfig): void {
        this._config = {
            collision:     config.collision     ?? undefined as any,
            eyeHeight:     config.eyeHeight     ?? 1.6,
            floorY:        config.floorY        ?? 0.0,
            speed:         config.speed         ?? 3.0,
            startPosition: config.startPosition ?? undefined as any,
            startYaw:      config.startYaw      ?? 0
        };
    }

    /**
     * Enter walk mode.
     * Sets the camera to fly-mode (for first-person mouse look), requests
     * Pointer Lock, and starts the per-frame update loop.
     */
    activate(): void {
        if (this._active) return;
        this._active = true;
        this._verticalVel = 0;

        // Fly control mode: camera.look() rotates in place (no orbit).
        this.scene.events.fire('camera.setControlMode', 'fly');

        // Place camera at configured start position (or keep current position).
        this._initPosition();

        document.addEventListener('keydown',          this._onKeyDown,           { passive: false });
        document.addEventListener('keyup',            this._onKeyUp);
        document.addEventListener('mousemove',        this._onMouseMove);
        document.addEventListener('pointerlockchange', this._onPointerLockChange);
        // Intercept dblclick in capture phase so PointerController never sees it.
        // Without this, dblclick fires camera.pickFocalPoint() which teleports
        // the camera outside the walkable area.
        document.addEventListener('dblclick',         this._onDblClick,          { capture: true });
        this.canvas.addEventListener('click',         this._onCanvasClick);
        window.addEventListener('blur',               this._onBlur);
        this.scene.events.on('update',                this._onUpdate);

        this._updateHint();
    }

    /** Exit walk mode and restore orbit camera. */
    deactivate(): void {
        if (!this._active) return;
        this._active = false;
        this._clearKeys();
        this._verticalVel = 0;

        if (this.pointerLocked) document.exitPointerLock();

        document.removeEventListener('keydown',           this._onKeyDown);
        document.removeEventListener('keyup',             this._onKeyUp);
        document.removeEventListener('mousemove',         this._onMouseMove);
        document.removeEventListener('pointerlockchange', this._onPointerLockChange);
        document.removeEventListener('dblclick',          this._onDblClick, { capture: true } as EventListenerOptions);
        this.canvas.removeEventListener('click',          this._onCanvasClick);
        window.removeEventListener('blur',                this._onBlur);
        this.scene.events.off('update',                   this._onUpdate);

        this.scene.events.fire('camera.setControlMode', 'orbit');
        this.hint.classList.add('hidden');
    }

    destroy(): void {
        this.deactivate();
        this.hint.remove();
    }

    // ── Private – initialisation ────────────────────────────────────────────

    private _initPosition(): void {
        const cam = this.scene.camera.mainCamera;
        const { startPosition, startYaw, eyeHeight, floorY, collision } = this._config;

        if (startPosition) {
            // Place exactly at the configured position
            cam.setPosition(startPosition[0], startPosition[1], startPosition[2]);
        } else {
            // Keep current XZ, clamp Y to floor
            const cur = cam.getPosition();
            const floorHit = collision?.loaded
                ? this._findFloor(cur)
                : floorY;
            cam.setPosition(cur.x, (floorHit ?? floorY) + eyeHeight + SPAWN_LIFT, cur.z);
        }

        // Apply initial yaw (azimuth) so the camera faces the right direction.
        // elev = 0 means looking horizontally forward.
        this.scene.camera.setAzimElev(startYaw ?? 0, 0);
    }

    // ── Private – per-frame physics ─────────────────────────────────────────

    private _update(dt: number): void {
        if (!this._active) return;
        // Cap dt to avoid physics explosions on tab-switch freeze
        const delta = Math.min(dt, 0.1);

        const cam    = this.scene.camera.mainCamera;
        const { collision, eyeHeight, floorY, speed } = this._config;

        // ── 1. Horizontal movement (XZ only) ─────────────────────────────────

        // Camera forward projected onto the horizontal plane
        const fwd3 = this.scene.camera.forward;
        _fwd.set(fwd3.x, 0, fwd3.z);
        if (_fwd.length() > 0.001) _fwd.normalize();

        // Right vector: Forward × Up in the XZ plane
        _right.set(-_fwd.z, 0, _fwd.x);

        // Accumulate desired velocity from key state
        _vel.set(0, 0, 0);
        if (this._keys.has('w') || this._keys.has('arrowup'))    _vel.add(_fwd);
        if (this._keys.has('s') || this._keys.has('arrowdown'))  _vel.sub(_fwd);
        if (this._keys.has('d') || this._keys.has('arrowright')) _vel.add(_right);
        if (this._keys.has('a') || this._keys.has('arrowleft'))  _vel.sub(_right);

        const speedMult = this._keys.has('shift') ? 3.0
                        : this._keys.has('alt')   ? 0.3
                        : 1.0;

        if (_vel.length() > 0.001) {
            _vel.normalize().mulScalar(speed * speedMult * delta);

            // Wall avoidance: cast a short ray in the movement direction.
            // If an obstacle is closer than WALL_CLEARANCE, skip movement.
            const pos = cam.getPosition();
            const blocked = collision?.loaded
                && collision.raycast(pos, _vel, WALL_CLEARANCE) !== null;

            if (!blocked) {
                cam.setPosition(pos.x + _vel.x, pos.y, pos.z + _vel.z);
            }
        }

        // ── 2. Floor clamping + gravity ───────────────────────────────────────

        const curPos = cam.getPosition();
        const foundFloor = collision?.loaded ? this._findFloor(curPos) : null;
        const targetY    = (foundFloor !== null ? foundFloor : floorY) + eyeHeight;

        if (foundFloor !== null) {
            // Standing on ground: reset vertical velocity, snap to floor
            this._verticalVel = 0;
            cam.setPosition(curPos.x, targetY, curPos.z);
        } else {
            // In the air: apply gravity
            this._verticalVel = Math.max(
                this._verticalVel - GRAVITY * delta,
                -TERMINAL_VELOCITY
            );
            const newY = curPos.y + this._verticalVel * delta;
            // Never fall below the fallback floorY
            cam.setPosition(curPos.x, Math.max(newY, floorY + eyeHeight), curPos.z);
        }

        this.scene.forceRender = true;
    }

    /**
     * Cast a downward ray from the camera position to find the floor surface Y.
     * Returns the world-space Y of the hit, or null if nothing was found.
     */
    private _findFloor(pos: Vec3): number | null {
        const dist = this._config.collision?.raycast(pos, _down, FLOOR_SEARCH_DIST);
        return dist !== null ? pos.y - dist : null;
    }

    // ── Private – input handlers ────────────────────────────────────────────

    private _requestPointerLock(): void {
        this.canvas.requestPointerLock();
    }

    private _handleCanvasClick(): void {
        if (this._active && !this.pointerLocked) {
            this._requestPointerLock();
        }
    }

    private _handleDblClick(event: MouseEvent): void {
        // Block PointerController's dblclick handler (camera.pickFocalPoint)
        // which would teleport the camera outside the walkable area.
        event.stopImmediatePropagation();
    }

    private _handlePointerLockChange(): void {
        if (!this._active) return;
        this._updateHint();
    }

    private _handleMouseMove(e: MouseEvent): void {
        if (!this._active || !this.pointerLocked) return;
        // camera.look() applies fly-mode rotation (yaw + pitch in place).
        this.scene.camera.look(e.movementX, e.movementY);
        this.scene.forceRender = true;
    }

    private _handleKeyDown(e: KeyboardEvent): void {
        if (!this._active) return;
        const key = e.key.toLowerCase();
        this._keys.add(key);
        // Block browser scroll for arrow keys
        if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(key)) {
            e.preventDefault();
        }
    }

    private _handleKeyUp(e: KeyboardEvent): void {
        if (!this._active) return;
        this._keys.delete(e.key.toLowerCase());
    }

    private _clearKeys(): void {
        this._keys.clear();
    }

    private _updateHint(): void {
        if (!this._active) {
            this.hint.classList.add('hidden');
            return;
        }
        this.hint.classList.remove('hidden');

        const key = (arrow: string, letter: string) =>
            `<span class="wasd-key"><span class="k-arrow">${arrow}</span><span class="k-letter">${letter}</span></span>`;

        const subMsg = this.pointerLocked
            ? '<span class="walk-hint-sub">Shift: 빠르게 &nbsp;·&nbsp; Esc: 마우스 해제</span>'
            : '';

        this.hint.innerHTML =
            '<div class="wasd-grid">' +
            '  <span></span>' +
            `  ${key('↑', 'W')}` +
            '  <span></span>' +
            `  ${key('←', 'A')}` +
            `  ${key('↓', 'S')}` +
            `  ${key('→', 'D')}` +
            '</div>' +
            '<span class="walk-mouse-hint">🖱&nbsp; 마우스로 방향 조절</span>' +
            subMsg;
    }
}
