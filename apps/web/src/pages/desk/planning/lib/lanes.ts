import type {
  PlanningLaneId,
  WorkOrderPlanningBlock,
} from '@prequest/shared';
import type { PlanningLane } from '../components/planning-grid';

/**
 * Pure lane-derivation for the planning board.
 *
 * The board is a grid of {assignee × time}. Each row is a `PlanningLane`
 * keyed by a `PlanningLaneId` (kind+id discriminator — see the shared
 * `WorkOrderPlanningBlock` type). The derivation rules:
 *
 *   1. Every `block.lane` in `planned[]` becomes a row, with that
 *      block (and any siblings on the same lane) collected under it.
 *   2. Every `block.lane` in `unscheduled[]` ALSO becomes a row, even
 *      though those blocks render in the left-rail (not on the grid).
 *      This is the codex 2026-05-12 fix: a user with open rail work but
 *      zero planned blocks for the day MUST appear as a drop target, or
 *      the dispatcher's most-common gesture (drag rail → empty lane) is
 *      impossible. We register the lane without pushing the rail block
 *      onto `lane.blocks` — those don't belong on the grid.
 *   3. Duplicate lane keys (same kind+id seen in both planned and
 *      unscheduled, or twice in planned) are deduped — the first
 *      occurrence's `label` wins.
 *
 * Insertion order is preserved: planned-lanes first (in the order their
 * first block appears), then unscheduled-only lanes. The page hands the
 * result to `PlanningGrid` which has its own `orderLanes` pass for the
 * final visual sort (unassigned first, kind-grouped). So this function
 * only needs to produce a stable, deduped collection.
 *
 * Extracted out of `DeskPlanningPage`'s useMemo so the rule can be unit-
 * tested without mounting the page — the regression that this guards
 * against ("operator can't drop rail work onto an idle assignee") is
 * silent and visual, easy to undo by accident in a refactor.
 */
export function deriveLanesFromBlocks(
  planned: ReadonlyArray<WorkOrderPlanningBlock>,
  unscheduled: ReadonlyArray<WorkOrderPlanningBlock>,
): PlanningLane[] {
  const map = new Map<string, PlanningLane>();

  const ensure = (laneId: PlanningLaneId): PlanningLane => {
    const key = `${laneId.kind}:${laneId.id ?? '∅'}`;
    let lane = map.get(key);
    if (!lane) {
      lane = { id: laneId, blocks: [] };
      map.set(key, lane);
    }
    return lane;
  };

  for (const block of planned) {
    const lane = ensure(block.lane);
    lane.blocks.push(block);
  }
  for (const block of unscheduled) {
    ensure(block.lane);
  }
  return Array.from(map.values());
}
