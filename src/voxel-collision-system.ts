/**
 * VoxelCollisionSystem – loads SuperSplat voxel.json + voxel.bin and
 * provides ray-against-voxel queries for walk-mode physics.
 *
 * File format (written by @playcanvas/splat-transform writeVoxel):
 *   voxel.json  – VoxelMetadata: bounds, resolution, node / leaf counts
 *   voxel.bin   – nodeCount × Uint32LE nodes | leafDataCount × Uint32LE leafData
 *
 * Octree format (Laine–Karras sparse voxel octree, BFS layout):
 *   Each Uint32 node = childMask(8 bits) | baseOffset(24 bits)
 *   SOLID_LEAF_MARKER = 0xFF000000  →  entire 4×4×4 block is solid
 *   Mixed leaf: lower 24 bits = pair index into leafData (lo,hi = 64-bit
 *               bitmask for 4×4×4 voxels, X-major bit order)
 *
 * Raycasting uses a 3-D DDA (Amanatides & Woo) at individual voxel resolution
 * (default 0.05 m/voxel).  The returned hit distance is always in world units
 * (metres) regardless of the magnitude of the direction vector.
 *
 * Usage:
 *   const col = new VoxelCollisionSystem();
 *   await col.load('data/hall/voxel.json');   // voxel.bin auto-derived
 *   const floorDist = col.raycast(pos, Vec3.DOWN, 5.0);
 */

import { Vec3 } from 'playcanvas';

import { ICollisionSystem } from './collision-system';

// ---------------------------------------------------------------------------
// Metadata type (mirrors VoxelMetadata in @playcanvas/splat-transform)
// ---------------------------------------------------------------------------

interface VoxelMetadata {
    version: number;
    gridBounds: {
        min: [number, number, number];
        max: [number, number, number];
    };
    sceneBounds: {
        min: [number, number, number];
        max: [number, number, number];
    };
    voxelResolution: number;  // metres per voxel (default 0.05)
    leafSize:        number;  // voxels per leaf-block edge (always 4)
    treeDepth:       number;  // total octree depth (root = 0)
    numInteriorNodes: number;
    numMixedLeaves:   number;
    nodeCount:        number; // total entries in nodes array
    leafDataCount:    number; // total entries in leafData array
}

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const SOLID_LEAF = 0xFF000000 >>> 0;   // force unsigned 32-bit

/** Branchless 32-bit popcount (Hamming weight). */
function popcount32(n: number): number {
    n = n - ((n >>> 1) & 0x55555555);
    n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
    n = (n + (n >>> 4)) & 0x0F0F0F0F;
    return (n * 0x01010101) >>> 24;
}

// ---------------------------------------------------------------------------
// VoxelCollisionSystem
// ---------------------------------------------------------------------------

export class VoxelCollisionSystem implements ICollisionSystem {
    private _meta: VoxelMetadata | null = null;
    private _nodes: Uint32Array | null = null;
    private _leafData: Uint32Array | null = null;
    private _loaded = false;

    // Cached per-load grid dimensions (in voxels) to avoid repeated division
    private _gx = 0;
    private _gy = 0;
    private _gz = 0;

    get loaded(): boolean { return this._loaded; }

    // ── Loading ──────────────────────────────────────────────────────────────

    /**
     * Fetch and parse voxel.json, then fetch the co-located voxel.bin.
     *
     * @param jsonUrl  URL to the voxel.json file.
     *                 The voxel.bin must sit at the same path with `.json → .bin`.
     * @returns `true` on success, `false` on any failure.
     */
    async load(jsonUrl: string): Promise<boolean> {
        try {
            // ── 1. Metadata ───────────────────────────────────────────────────
            const jsonRes = await fetch(jsonUrl);
            if (!jsonRes.ok) {
                console.warn('[VoxelCollision] Failed to fetch:', jsonUrl, jsonRes.status);
                return false;
            }
            const meta: VoxelMetadata = await jsonRes.json();

            if (typeof meta.treeDepth !== 'number' || meta.treeDepth < 1) {
                console.warn('[VoxelCollision] Invalid treeDepth in:', jsonUrl);
                return false;
            }

            // ── 2. Binary data ────────────────────────────────────────────────
            const binUrl = jsonUrl.replace(/\.json$/i, '.bin');
            const binRes = await fetch(binUrl);
            if (!binRes.ok) {
                console.warn('[VoxelCollision] Failed to fetch:', binUrl, binRes.status);
                return false;
            }
            const buffer = await binRes.arrayBuffer();

            const expectedBytes = (meta.nodeCount + meta.leafDataCount) * 4;
            if (buffer.byteLength < expectedBytes) {
                console.warn(
                    `[VoxelCollision] bin too small: ${buffer.byteLength} < ${expectedBytes}`
                );
                return false;
            }

            // ── 3. Slice into typed arrays ────────────────────────────────────
            this._nodes    = new Uint32Array(buffer, 0,                  meta.nodeCount);
            this._leafData = new Uint32Array(buffer, meta.nodeCount * 4, meta.leafDataCount);
            this._meta     = meta;

            const vr = meta.voxelResolution;
            const gb = meta.gridBounds;
            this._gx = Math.round((gb.max[0] - gb.min[0]) / vr);
            this._gy = Math.round((gb.max[1] - gb.min[1]) / vr);
            this._gz = Math.round((gb.max[2] - gb.min[2]) / vr);

            this._loaded = true;
            console.log(
                `[VoxelCollision] Loaded: ${meta.nodeCount} nodes, ` +
                `${meta.leafDataCount} leafData, depth=${meta.treeDepth}, ` +
                `grid=${this._gx}×${this._gy}×${this._gz} voxels`
            );
            return true;
        } catch (err) {
            console.error('[VoxelCollision] Load error:', err);
            return false;
        }
    }

    // ── Private – octree point query (integer voxel indices) ─────────────────

    /**
     * Test whether the voxel at integer grid coordinates (ix, iy, iz) is solid.
     * Bounds checking is the caller's responsibility.
     */
    private _queryVoxel(ix: number, iy: number, iz: number): boolean {
        const nodes    = this._nodes!;
        const leafData = this._leafData!;
        const depth    = this._meta!.treeDepth;

        // Leaf-block coords (each block = 4×4×4 voxels, leafSize = 4)
        const lx = ix >>> 2;
        const ly = iy >>> 2;
        const lz = iz >>> 2;

        // Sub-voxel position within the 4×4×4 block (0–3 per axis)
        const vx = ix & 3;
        const vy = iy & 3;
        const vz = iz & 3;

        // ── Traverse octree from root to leaf level ───────────────────────────
        // treeDepth == 7 means 7 subdivision steps (the leaf blocks live at
        // level 7 of the tree, giving 2^7 = 128 positions per axis).
        // We loop exactly `depth` times: after the last iteration nodeIdx
        // points to the leaf block descriptor in the nodes array.

        let nodeIdx = 0;

        for (let l = 0; l < depth; l++) {
            const node       = nodes[nodeIdx];
            const childMask  = (node >>> 24) & 0xFF;
            const baseOffset =  node & 0xFFFFFF;

            const bitPos = depth - 1 - l;
            const octant =
                ((lx >>> bitPos) & 1)        |
               (((ly >>> bitPos) & 1) << 1)  |
               (((lz >>> bitPos) & 1) << 2);

            if ((childMask & (1 << octant)) === 0) return false;   // empty subtree

            // Packed children: count how many children precede this octant.
            const before = popcount32(childMask & ((1 << octant) - 1));
            nodeIdx = baseOffset + before;
        }

        // ── Leaf node ──────────────────────────────────────────────────────────
        const leafNode = nodes[nodeIdx];

        if ((leafNode >>> 0) === SOLID_LEAF) return true;   // solid 4×4×4 block

        // Mixed leaf: lower 24 bits = index of the (lo, hi) pair in leafData
        const leafIdx = leafNode & 0xFFFFFF;
        // X-major bit layout: bitIdx = vx + vy*4 + vz*16
        const bitIdx  = vx + vy * 4 + vz * 16;
        if (bitIdx < 32) {
            return ((leafData[leafIdx * 2] >>> bitIdx) & 1) !== 0;
        }
        return ((leafData[leafIdx * 2 + 1] >>> (bitIdx - 32)) & 1) !== 0;
    }

    // ── Public – ICollisionSystem ─────────────────────────────────────────────

    /**
     * Cast a ray through the voxel grid using 3-D DDA (Amanatides & Woo).
     *
     * The returned distance is always in world units (metres), irrespective of
     * the magnitude of `direction`.
     *
     * @param origin    Ray origin in world space (metres)
     * @param direction Ray direction (does not need to be normalised)
     * @param maxDist   Maximum hit distance to test (metres)
     * @returns Distance to the nearest solid voxel surface, or `null` if none.
     */
    raycast(origin: Vec3, direction: Vec3, maxDist: number): number | null {
        if (!this._meta || !this._nodes) return null;

        const { gridBounds: gb, voxelResolution: vr } = this._meta;

        // Normalise direction so DDA t-values are in metres.
        const dx = direction.x, dy = direction.y, dz = direction.z;
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len < 1e-10) return null;
        const nx = dx / len, ny = dy / len, nz = dz / len;

        const ox = origin.x, oy = origin.y, oz = origin.z;

        // Starting integer voxel
        let vx = Math.floor((ox - gb.min[0]) / vr);
        let vy = Math.floor((oy - gb.min[1]) / vr);
        let vz = Math.floor((oz - gb.min[2]) / vr);

        // Step direction per axis
        const sx = nx > 0 ? 1 : (nx < 0 ? -1 : 0);
        const sy = ny > 0 ? 1 : (ny < 0 ? -1 : 0);
        const sz = nz > 0 ? 1 : (nz < 0 ? -1 : 0);

        // tDelta: metres to cross one voxel along each axis
        const tDx = sx !== 0 ? vr / Math.abs(nx) : Infinity;
        const tDy = sy !== 0 ? vr / Math.abs(ny) : Infinity;
        const tDz = sz !== 0 ? vr / Math.abs(nz) : Infinity;

        // tMax: metres to the first voxel boundary in each axis from origin
        const bndX = gb.min[0] + (vx + (sx > 0 ? 1 : 0)) * vr;
        const bndY = gb.min[1] + (vy + (sy > 0 ? 1 : 0)) * vr;
        const bndZ = gb.min[2] + (vz + (sz > 0 ? 1 : 0)) * vr;
        let tMx = sx !== 0 ? (bndX - ox) / nx : Infinity;
        let tMy = sy !== 0 ? (bndY - oy) / ny : Infinity;
        let tMz = sz !== 0 ? (bndZ - oz) / nz : Infinity;

        const { _gx: gx, _gy: gy, _gz: gz } = this;

        let t = 0;

        while (t <= maxDist) {
            // Check occupancy only if within grid
            if (vx >= 0 && vx < gx && vy >= 0 && vy < gy && vz >= 0 && vz < gz) {
                if (this._queryVoxel(vx, vy, vz)) return t;
            } else if (t > 0) {
                // We have left the grid — stop marching
                break;
            }

            // Advance to next voxel crossing (smallest t-max axis)
            if (tMx <= tMy && tMx <= tMz) {
                t = tMx; vx += sx; tMx += tDx;
            } else if (tMy <= tMz) {
                t = tMy; vy += sy; tMy += tDy;
            } else {
                t = tMz; vz += sz; tMz += tDz;
            }

            if (t > maxDist) break;
        }

        return null;
    }
}
