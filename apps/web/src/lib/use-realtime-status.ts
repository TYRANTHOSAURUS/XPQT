import { useEffect, useState } from 'react';
import { supabase } from './supabase';

export type RealtimeStatus = 'open' | 'reconnecting' | 'broken';

/**
 * Probes the Supabase Realtime connection state via a lightweight channel
 * subscription. Returns:
 *   'open'         — SUBSCRIBED
 *   'reconnecting' — any transitional state (initial, SUBSCRIBING, etc.)
 *   'broken'       — CLOSED | CHANNEL_ERROR | TIMED_OUT
 *
 * The channel is torn down on unmount. Designed to be mounted once per page
 * that has live availability data (e.g. the floor-plan booking surface).
 */
export function useRealtimeStatus(): RealtimeStatus {
  const [status, setStatus] = useState<RealtimeStatus>('reconnecting');

  useEffect(() => {
    const channel = supabase
      .channel('_realtime_status_probe', { config: { broadcast: { self: true } } })
      .subscribe((s) => {
        if (s === 'SUBSCRIBED') {
          setStatus('open');
        } else if (s === 'CLOSED' || s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') {
          setStatus('broken');
        } else {
          setStatus('reconnecting');
        }
      });

    return () => {
      void supabase.removeChannel(channel);
    };
  }, []);

  return status;
}
