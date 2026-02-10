import { createClient } from '@supabase/supabase-js';

// Build-time (funciona en local con .env)
const buildUrl = import.meta.env.VITE_SUPABASE_URL ?? '';
const buildKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

// Runtime (funciona en producción via config.js — cargado en index.html antes del bundle)
const runtimeConfig = (typeof window !== 'undefined')
  ? (window as any).__PALPORRO_CONFIG
  : undefined;

const supabaseUrl: string = buildUrl || runtimeConfig?.VITE_SUPABASE_URL || '';
const supabaseAnonKey: string = buildKey || runtimeConfig?.VITE_SUPABASE_ANON_KEY || '';

console.log('🔍 Supabase Config:', {
  source: buildUrl ? 'build-time .env' : runtimeConfig ? 'runtime config.js' : 'NINGUNO ❌',
  hasUrl: !!supabaseUrl,
  hasKey: !!supabaseAnonKey
});

export let supabase = (supabaseUrl && supabaseAnonKey)
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;

export function getEnvironment(): string {
  return import.meta.env.VITE_ENVIRONMENT
    || runtimeConfig?.VITE_ENVIRONMENT
    || 'PROD';
}

export interface VoteData {
  pilot: string;
  days: string[];
  times: string[];
  ip?: string | null;
  timestamp: number;
}

// Obtener todos los votos
export async function getVotes(environment: string = 'TEST'): Promise<VoteData[]> {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from('palporro_votes')
    .select('*')
    .eq('environment', environment);

  if (error) {
    console.error('Error fetching votes:', error);
    return [];
  }

  return data || [];
}

// Agregar o actualizar voto (upsert)
export async function addVote(
  voteData: VoteData,
  environment: string = 'TEST'
): Promise<boolean> {
  // Try using the supabase-js client first
  if (supabase) {
    try {
      console.log('addVote: using supabase-js client');
      const { error } = await supabase
        .from('palporro_votes')
        .upsert({
          pilot: voteData.pilot,
          days: voteData.days,
          times: voteData.times,
          ip: voteData.ip || null,
          timestamp: voteData.timestamp,
          environment
        }, {
          onConflict: 'pilot,environment'
        });

      if (!error) {
        console.log('addVote: supabase-js client upsert succeeded');
        return true;
      }
      console.error('Error adding vote via supabase-js client:', error);
    } catch (err) {
      console.error('Supabase client upsert error:', err);
    }
  } else {
    console.warn('Supabase client not initialized - will try REST fallback');
  }

  // REST fallback: POST directly to Supabase REST endpoint using anon key
  if (supabaseUrl && supabaseAnonKey) {
    try {
      const url = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/palporro_votes?on_conflict=pilot,environment`;
      const payload = {
        pilot: voteData.pilot,
        days: voteData.days,
        times: voteData.times,
        ip: voteData.ip || null,
        timestamp: voteData.timestamp,
        environment
      };

      console.log('addVote: REST fallback POST', { url, payload });
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: supabaseAnonKey,
          Authorization: `Bearer ${supabaseAnonKey}`,
          Prefer: 'return=representation,resolution=merge-duplicates'
        },
        body: JSON.stringify(payload)
      });

      if (resp.ok) {
        const js = await resp.json().catch(() => null);
        console.log('addVote: REST fallback succeeded', js);
        return true;
      }
      const body = await resp.text().catch(() => '');
      console.error('addVote: REST fallback failed', resp.status, body);
      return false;
    } catch (err) {
      console.error('addVote: REST fallback error', err);
      return false;
    }
  }

  console.error('Supabase not available and no REST fallback configured (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY missing)');
  return false;
}

// Suscribirse a cambios en tiempo real
export function subscribeToVotes(
  environment: string,
  callback: (votes: VoteData[]) => void
) {
  if (!supabase) {
    return () => {};
  }

  const channel = supabase
    .channel('palporro-votes-changes')
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'palporro_votes',
        filter: `environment=eq.${environment}`
      },
      async () => {
        const votes = await getVotes(environment);
        callback(votes);
      }
    )
    .subscribe();

  return () => {
    supabase!.removeChannel(channel);
  };
}

// Obtener estadísticas de votación
export async function getVotingStats(environment: string = 'TEST') {
  const votes = await getVotes(environment);

  const dayCount: Record<string, number> = {};
  const timeCount: Record<string, number> = {};

  votes.forEach(vote => {
    vote.days.forEach(day => {
      dayCount[day] = (dayCount[day] || 0) + 1;
    });
    vote.times.forEach(time => {
      timeCount[time] = (timeCount[time] || 0) + 1;
    });
  });

  return {
    totalVotes: votes.length,
    dayCount,
    timeCount,
    mostPopularDay: Object.entries(dayCount).sort((a, b) => b[1] - a[1])[0]?.[0],
    mostPopularTime: Object.entries(timeCount).sort((a, b) => b[1] - a[1])[0]?.[0]
  };
}

export async function getVoteByIp(
  ip: string,
  environment: string = 'PROD'
): Promise<VoteData | null> {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from('palporro_votes')
    .select('*')
    .eq('environment', environment)
    .eq('ip', ip)
    .maybeSingle();

  if (error) {
    console.error('Error fetching vote by IP:', error);
    return null;
  }

  return data;
}