/**
 * Fallback client-side helpers for pinned track management.
 * Exports: getPinnedTrack, pinNextTrack, subscribeToNextTrack
 */

export function getPinnedTrack(): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem('palporro_next_track') : null;
  } catch (e) {
    return null;
  }
}

export function pinNextTrack(trackName: string | null): void {
  try {
    if (typeof localStorage !== 'undefined') {
      if (trackName) localStorage.setItem('palporro_next_track', trackName);
      else localStorage.removeItem('palporro_next_track');
      // Notify other listeners in same window
      try {
        window.dispatchEvent(new CustomEvent('palporro_next_track_changed', { detail: { track: trackName } }));
      } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }
}

export function subscribeToNextTrack(callback: (track: string | null) => void) {
  const handler = (e: Event) => {
    const ce: any = e as any;
    const track = ce?.detail?.track ?? getPinnedTrack();
    try { callback(track); } catch (_) { /* ignore callback errors */ }
  };

  window.addEventListener('palporro_next_track_changed', handler as EventListener);

  // Return unsubscribe function
  return () => {
    window.removeEventListener('palporro_next_track_changed', handler as EventListener);
  };
}

