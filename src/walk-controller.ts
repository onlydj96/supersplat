/**
 * WalkController – First-person walk mode for the SuperSplat viewer.
 *
 * Reuses the existing fly-mode movement infrastructure already built into
 * PointerController (camera.fly.* events + ground-locked WASD movement),
 * adding Pointer Lock so the mouse freely controls the look direction.
 *
 * Controls (while active)
 * ──────────────────────
 *  W / ↑     move forward
 *  S / ↓     move backward
 *  A / ←     strafe left
 *  D / →     strafe right
 *  Q          descend
 *  E          ascend
 *  Shift      move faster (×10)
 *  Alt        move slower (×0.1)
 *  Escape     release pointer lock (click canvas to re-acquire)
 */

import { Scene } from './scene';

export class WalkController {
    private readonly scene: Scene;
    private readonly canvas: HTMLCanvasElement;
    private readonly hint: HTMLElement;

    private _active = false;
    private readonly _keys = new Set<string>();

    // Pre-bound handlers so they can be cleanly removed
    private readonly _onKeyDown: (e: KeyboardEvent) => void;
    private readonly _onKeyUp: (e: KeyboardEvent) => void;
    private readonly _onMouseMove: (e: MouseEvent) => void;
    private readonly _onPointerLockChange: () => void;
    private readonly _onCanvasClick: () => void;
    private readonly _onBlur: () => void;

    constructor(scene: Scene, canvas: HTMLCanvasElement) {
        this.scene = scene;
        this.canvas = canvas;

        // Floating hint overlay (created once, shown/hidden via CSS class)
        this.hint = document.createElement('div');
        this.hint.id = 'walk-hint';
        this.hint.className = 'walk-hint hidden';
        this.hint.textContent =
            'W A S D  to move  ·  mouse to look  ·  Q / E  to change height  ·  Esc  to release mouse';
        document.body.appendChild(this.hint);

        this._onKeyDown = this._handleKeyDown.bind(this);
        this._onKeyUp = this._handleKeyUp.bind(this);
        this._onMouseMove = this._handleMouseMove.bind(this);
        this._onPointerLockChange = this._handlePointerLockChange.bind(this);
        this._onCanvasClick = this._handleCanvasClick.bind(this);
        this._onBlur = this._clearKeys.bind(this);
    }

    get active(): boolean { return this._active; }

    get pointerLocked(): boolean {
        return document.pointerLockElement === this.canvas;
    }

    /**
     * Enter walk mode.
     * Switches camera to 'fly' control mode and requests Pointer Lock.
     * The browser may require a user gesture before Pointer Lock is granted.
     */
    activate(): void {
        if (this._active) return;
        this._active = true;

        // Fly mode: PointerController's update() handles WASD movement with
        // horizontal ground-lock, and camera.look() handles look direction.
        this.scene.events.fire('camera.setControlMode', 'fly');

        document.addEventListener('keydown', this._onKeyDown, { passive: false });
        document.addEventListener('keyup', this._onKeyUp);
        document.addEventListener('mousemove', this._onMouseMove);
        document.addEventListener('pointerlockchange', this._onPointerLockChange);
        this.canvas.addEventListener('click', this._onCanvasClick);
        window.addEventListener('blur', this._onBlur);

        this._requestPointerLock();
        this._updateHint();
    }

    /** Exit walk mode and restore orbit camera. */
    deactivate(): void {
        if (!this._active) return;
        this._active = false;

        this._clearKeys();

        if (this.pointerLocked) document.exitPointerLock();

        document.removeEventListener('keydown', this._onKeyDown);
        document.removeEventListener('keyup', this._onKeyUp);
        document.removeEventListener('mousemove', this._onMouseMove);
        document.removeEventListener('pointerlockchange', this._onPointerLockChange);
        this.canvas.removeEventListener('click', this._onCanvasClick);
        window.removeEventListener('blur', this._onBlur);

        this.scene.events.fire('camera.setControlMode', 'orbit');
        this.hint.classList.add('hidden');
    }

    destroy(): void {
        this.deactivate();
        this.hint.remove();
    }

    // ── Private ────────────────────────────────────────────────────────────

    private _requestPointerLock(): void {
        this.canvas.requestPointerLock();
    }

    private _handleCanvasClick(): void {
        // Re-acquire pointer lock if it was released by Escape
        if (this._active && !this.pointerLocked) {
            this._requestPointerLock();
        }
    }

    private _handlePointerLockChange(): void {
        if (!this._active) return;
        // Pointer lock was released (Escape key or programmatically).
        // Stay in walk mode so the user can click to re-acquire.
        this._updateHint();
    }

    private _handleMouseMove(e: MouseEvent): void {
        if (!this._active || !this.pointerLocked) return;

        // camera.look() accepts pixel deltas and applies orbitSensitivity internally.
        // movementX/Y is equivalent to the dx/dy a pointer-drag produces.
        this.scene.camera.look(e.movementX, e.movementY);
        this.scene.forceRender = true;
    }

    private _handleKeyDown(e: KeyboardEvent): void {
        if (!this._active) return;

        const key = e.key.toLowerCase();
        if (!this._keys.has(key)) {
            this._keys.add(key);
            this._fireMovementKey(key, true);
        }

        // Block browser scroll for movement keys
        if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) {
            e.preventDefault();
        }
    }

    private _handleKeyUp(e: KeyboardEvent): void {
        if (!this._active) return;

        const key = e.key.toLowerCase();
        this._keys.delete(key);
        this._fireMovementKey(key, false);
    }

    /**
     * Translate key names into the camera.fly.* / camera.modifier.* events
     * that PointerController already listens to.
     */
    private _fireMovementKey(key: string, down: boolean): void {
        const { events } = this.scene;
        switch (key) {
            case 'w': case 'arrowup':    events.fire('camera.fly.forward',  down); break;
            case 's': case 'arrowdown':  events.fire('camera.fly.backward', down); break;
            case 'a': case 'arrowleft':  events.fire('camera.fly.left',     down); break;
            case 'd': case 'arrowright': events.fire('camera.fly.right',    down); break;
            case 'q':                    events.fire('camera.fly.down',     down); break;
            case 'e':                    events.fire('camera.fly.up',       down); break;
            case 'shift':                events.fire('camera.modifier.fast', down); break;
            case 'alt':                  events.fire('camera.modifier.slow', down); break;
        }
    }

    private _clearKeys(): void {
        for (const key of this._keys) {
            this._fireMovementKey(key, false);
        }
        this._keys.clear();
    }

    private _updateHint(): void {
        if (!this._active) {
            this.hint.classList.add('hidden');
            return;
        }

        this.hint.classList.remove('hidden');

        if (this.pointerLocked) {
            this.hint.textContent =
                'W A S D  ·  mouse to look  ·  Q / E  ·  Shift faster  ·  Esc to release mouse';
        } else {
            this.hint.textContent = 'Click to capture mouse and enter walk mode';
        }
    }
}
