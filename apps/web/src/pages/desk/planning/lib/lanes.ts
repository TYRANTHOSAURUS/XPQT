import type {
  PlanningLaneId,
  WorkOrderPlanningBlock,
} from '@prequest/shared';
import type { PlanningLane } from '../components/planning-grid';

/**
 * Pure lane-derivation for the planning board.
 *
 * Two operating modes, decided by whether the server supplied a lane
 * set:
 *
 *   - **Server-supplied (P1-1 path).** `providedLaneIds` non-null —
 *     the lane set is the server's truth (full team roster when a
 *     team filter is active, idle assignees included). The blocks
 *     get grouped under their matching lane; lanes with zero blocks
 *     remain in the result as empty drop targets. The server already
 *     sorted in the canonical key order (unassigned → alpha by label
 *     → kind) so we preserve insertion order rather than re-sort.
 *
 *   - **Fallback / legacy.** `providedLaneIds` null — derive lanes
 *     purely from returned blocks (the pre-P1-1 behaviour, kept so
 *     the page still functions during initial load before
 *     `data.lanes` is available, and so a server response missing
 *     the field doesn't crash the page). Every `block.lane` in
 *     planned[] AND unscheduled[] registers a row. Rail-only blocks
 *     register their lane as a drop target without pushing the
 *     block onto `lane.blocks` (rail items render in the rail, not
 *     on the grid).
 *
 * Dedup discipline is the same in both modes — `{kind}:{id}` is the
 * stable key.
 *
 * Why the fallback stays: the regression that "an operator can't drop
 * rail work onto an idle assignee" is silent and visual; the unit test
 * covers it specifically.
 */
export function deriveLanesFromBlocks(
  planned: ReadonlyArray<WorkOrderPlanningBlock>,
  unscheduled: ReadonlyArray<WorkOrderPlanningBlock>,
  providedLaneIds?: ReadonlyArray<PlanningLaneId> | null,
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

  // Server-supplied path: seed the lane set FIRST so the server's
  // label + iteration order win. Block-derived lanes layered on top
  // are deduped by key — a planned block whose lane is already in the
  // map just appends to that lane's blocks[].
  if (providedLaneIds) {
    for (const id of providedLaneIds) ensure(id);
  }

  for (const block of planned) {
    const lane = ensure(block.lane);
    lane.blocks.push(block);
  }
  for (const block of unscheduled) {
    ensure(block.lane);
  }
  return Array.from(map.values());
}
