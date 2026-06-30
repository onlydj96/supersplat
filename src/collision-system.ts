/**
 * CollisionSystem – loads a GLB collision mesh and provides
 * ray-triangle intersection queries for walk-mode physics.
 *
 * Usage:
 *   const col = new CollisionSystem();
 *   await col.load('data/hall/collision.glb', scene.app);
 *   const floorDist = col.raycast(pos, Vec3.DOWN, 5.0);
 */

import { Asset, Mat4, Vec3 } from 'playcanvas';

// ---------------------------------------------------------------------------
// Common interface
// ---------------------------------------------------------------------------

/**
 * Minimal interface shared by GLB-based and voxel-based collision systems.
 * WalkController depends on this, not on any concrete class.
 */
export interface ICollisionSystem {
    readonly loaded: boolean;
    raycast(origin: Vec3, direction: Vec3, maxDist: number): number | null;
}

// ---------------------------------------------------------------------------
// Pre-allocated scratch vectors (avoid per-frame heap allocation)
// ---------------------------------------------------------------------------
const _e1 = new Vec3();
const _e2 = new Vec3();
const _h  = new Vec3();
const _s  = new Vec3();
const _q  = new Vec3();

/**
 * Möller–Trumbore ray-triangle intersection.
 * Returns distance `t` along the ray if hit, or `null` if no intersection.
 * The ray direction does NOT need to be normalised — returned `t` is in the
 * same units as `dir`.
 */
function rayTriangle(
    orig: Vec3, dir: Vec3,
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number
): number | null {
    const EPSILON = 1e-7;

    _e1.set(bx - ax, by - ay, bz - az);
    _e2.set(cx - ax, cy - ay, cz - az);

    // h = dir × e2
    _h.copy(dir).cross(_e2);
    const a = _e1.dot(_h);
    if (Math.abs(a) < EPSILON) return null; // ray parallel to triangle

    const f = 1.0 / a;
    _s.set(orig.x - ax, orig.y - ay, orig.z - az);
    const u = f * _s.dot(_h);
    if (u < 0.0 || u > 1.0) return null;

    // q = s × e1
    _q.copy(_s).cross(_e1);
    const v = f * dir.dot(_q);
    if (v < 0.0 || u + v > 1.0) return null;

    const t = f * _e2.dot(_q);
    return t > EPSILON ? t : null;
}

// ---------------------------------------------------------------------------
// CollisionSystem
// ---------------------------------------------------------------------------

export class CollisionSystem implements ICollisionSystem {
    /**
     * Baked world-space triangle soup.
     * Layout: [ax, ay, az, bx, by, bz, cx, cy, cz, ...] — 9 floats per triangle.
     */
    private _triangles: Float32Array | null = null;
    private _triangleCount = 0;
    private _loaded = false;

    get loaded(): boolean { return this._loaded; }
    get triangleCount(): number { return this._triangleCount; }

    /**
     * Load a GLB file, extract its world-space triangle data, and cache it.
     *
     * @param url  URL of the GLB collision mesh (relative to `dist/` or absolute)
     * @param app  PlayCanvas Application instance (`scene.app`)
     * @returns    `true` on success, `false` if the asset failed or had no geometry
     */
    async load(url: string, app: any): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            const asset = new Asset('collision-mesh', 'container', { url });
            app.assets.add(asset);

            asset.on('load', () => {
                try {
                    const container = asset.resource as any;
                    const model = container?.model;
                    const meshInstances: any[] = model?.meshInstances ?? [];

                    if (meshInstances.length === 0) {
                        console.warn('[CollisionSystem] GLB has no mesh instances:', url);
                        resolve(false);
                        return;
                    }

                    const allTris: number[] = [];
                    const worldMat = new Mat4();
                    const vA = new Vec3();
                    const vB = new Vec3();
                    const vC = new Vec3();

                    for (const mi of meshInstances) {
                        const mesh = mi.mesh;
                        const node = mi.node;

                        const positions: number[] = [];
                        const indices: number[] = [];
                        mesh.getPositions(positions);
                        mesh.getIndices(indices);

                        // Bake node world transform into vertices so the
                        // triangle data is always in world space.
                        if (node) {
                            worldMat.copy(node.getWorldTransform());
                        } else {
                            worldMat.setIdentity();
                        }

                        for (let i = 0; i < indices.length; i += 3) {
                            const i0 = indices[i]     * 3;
                            const i1 = indices[i + 1] * 3;
                            const i2 = indices[i + 2] * 3;

                            vA.set(positions[i0],     positions[i0 + 1], positions[i0 + 2]);
                            vB.set(positions[i1],     positions[i1 + 1], positions[i1 + 2]);
                            vC.set(positions[i2],     positions[i2 + 1], positions[i2 + 2]);

                            worldMat.transformPoint(vA, vA);
                            worldMat.transformPoint(vB, vB);
                            worldMat.transformPoint(vC, vC);

                            allTris.push(
                                vA.x, vA.y, vA.z,
                                vB.x, vB.y, vB.z,
                                vC.x, vC.y, vC.z
                            );
                        }
                    }

                    if (allTris.length === 0) {
                        console.warn('[CollisionSystem] No triangles extracted from:', url);
                        resolve(false);
                        return;
                    }

                    this._triangles = new Float32Array(allTris);
                    this._triangleCount = allTris.length / 9;
                    this._loaded = true;
                    console.log(`[CollisionSystem] Loaded ${this._triangleCount} triangles from ${url}`);
                    resolve(true);
                } catch (err) {
                    console.error('[CollisionSystem] Failed to extract triangles:', err);
                    resolve(false);
                }
            });

            asset.on('error', (err: any) => {
                console.error('[CollisionSystem] Asset load error:', err);
                resolve(false);
            });

            app.assets.load(asset);
        });
    }

    /**
     * Cast a ray and return the **closest hit distance**, or `null` if no hit.
     *
     * @param origin    Ray origin in world space
     * @param direction Ray direction (need not be normalised)
     * @param maxDist   Maximum hit distance to test (in world units)
     */
    raycast(origin: Vec3, direction: Vec3, maxDist: number): number | null {
        if (!this._triangles || this._triangleCount === 0) return null;

        const tris = this._triangles;
        let closest: number | null = null;

        for (let i = 0; i < this._triangleCount; i++) {
            const b = i * 9;
            const t = rayTriangle(
                origin, direction,
                tris[b],     tris[b + 1], tris[b + 2],
                tris[b + 3], tris[b + 4], tris[b + 5],
                tris[b + 6], tris[b + 7], tris[b + 8]
            );
            if (t !== null && t <= maxDist && (closest === null || t < closest)) {
                closest = t;
            }
        }

        return closest;
    }
}
