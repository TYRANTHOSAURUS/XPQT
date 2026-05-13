import type { Tool } from './tool';

/**
 * Select tool — intentionally has NO pointer handlers.
 *
 * The DesignerCanvas drives selection + drag-to-move directly:
 *   - click on polygon  → select   (via PolygonShape's own onClick)
 *   - click on empty    → deselect (via SVG onClick handler)
 *   - drag on polygon   → translate it (via SVG pointer-down + capture)
 *
 * A previous version dispatched `select-polygon: null` on every pointer-down,
 * which fought the polygon's onClick and made clicks feel broken (instant
 * deselect-then-select flicker, and pointer-capture occasionally swallowed
 * the click entirely).
 */
export const selectTool: Tool = {};
