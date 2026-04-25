import { Injectable } from '@nestjs/common';

/**
 * RankingService — smart room suggestions / "best match" sort.
 *
 * v1 is rule-based (per spec §3.2):
 *   - criteria match (must-haves are filters; preferred amenities boost)
 *   - distance to requester's default_location (TODO once persons.default_location_id is wired)
 *   - team affinity (TODO once we have a usage history surface)
 *   - capacity fit (closer to requested attendee_count > much-larger room)
 *   - utilization balance (TODO once we have utilization stats)
 *
 * Future: ML-friendly shape — return scores so we can train.
 *
 * Reasons are surfaced inline in the picker so users see WHY a room is at
 * the top ("Used by your team 6× this month · matches whiteboard + video").
 */
@Injectable()
export class RankingService {
  score(
    space: {
      id: string;
      capacity: number | null;
      amenities: string[] | null;
      default_search_keywords: string[] | null;
    },
    _requesterId: string,
    input: { attendee_count: number; preferred_amenities?: string[]; smart_keywords?: string[] },
  ): { score: number; reasons: string[] } {
    let score = 0;
    const reasons: string[] = [];

    // Capacity fit — closer to attendee_count is better
    if (space.capacity !== null) {
      const overshoot = space.capacity - input.attendee_count;
      if (overshoot >= 0 && overshoot <= 2) {
        score += 30;
        reasons.push(overshoot === 0 ? 'Exact capacity fit' : 'Tight capacity fit');
      } else if (overshoot <= 5) {
        score += 15;
      } else if (overshoot > 10) {
        score -= 5;
        reasons.push('Larger than needed');
      }
    }

    // Preferred amenities — non-required boosters
    const ams = (space.amenities ?? []).map((a) => a.toLowerCase());
    const preferred = (input.preferred_amenities ?? []).map((a) => a.toLowerCase());
    let prefMatches = 0;
    for (const p of preferred) if (ams.includes(p)) prefMatches++;
    if (prefMatches > 0) {
      score += prefMatches * 8;
      reasons.push(`Matches ${prefMatches} preferred amenity${prefMatches === 1 ? '' : 's'}`);
    }

    // Smart keyword match (free-text tags on the room vs the user's input)
    const kws = (space.default_search_keywords ?? []).map((s) => s.toLowerCase());
    const want = (input.smart_keywords ?? []).map((s) => s.toLowerCase());
    let kwMatches = 0;
    for (const k of want) if (kws.includes(k)) kwMatches++;
    if (kwMatches > 0) {
      score += kwMatches * 4;
    }

    // TODO: team-affinity boost when we have usage history
    // TODO: distance/walk-time boost when persons.default_location_id is wired
    // TODO: utilization-balance signal — slightly boost under-used rooms

    return { score, reasons };
  }
}
