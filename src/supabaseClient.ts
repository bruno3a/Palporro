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

// ============================================
// RACE HISTORY FUNCTIONS
// ============================================

export interface RaceResult {
  pilot: string;
  position: number;
  totalTime: string;
  bestLap: string;
  isWinner: boolean;
  // Optional flag to mark that the pilot did not show up
  isNoShow?: boolean;
  // Additional data from race JSON
  laps?: number;
  incidents?: number;
  status?: string;
  bestSectors?: {
    S1?: string;
    S2?: string;
    S3?: string;
  };
}

export interface RaceHistory {
  id: string;
  race_number: number;
  track_name: string;
  scheduled_date: string;
  scheduled_day: string;
  scheduled_time: string;
  confirmed_pilots: string[];
  race_completed: boolean;
  race_results: RaceResult[];
  created_at: string;
  completed_at?: string;
  // Additional race metadata
  session_info?: {
    track?: string;
    format?: string;
    vehicle?: string;
  };
  relevant_data?: {
    performance?: string;
    summary?: string;
  };
}

export let supabase = (supabaseUrl && supabaseAnonKey)
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;

const getClient = (environment: string) => {
  return supabase; 
};

export function getEnvironment(): string {
  return import.meta.env.VITE_ENVIRONMENT
    || runtimeConfig?.VITE_ENVIRONMENT
    || 'PROD';
}

export interface TimeSlot {
  day: string;
  time: string;
}

export interface VoteData {
  pilot: string;
  slots: TimeSlot[];
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
          slots: voteData.slots,
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
        slots: voteData.slots,
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

  console.error('Supabase not available and no REST fallback configured');
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

// Obtener estadísticas de votación (ahora basado en slots)
export async function getVotingStats(environment: string = 'TEST') {
  const votes = await getVotes(environment);

  const slotCount: Record<string, number> = {};

  votes.forEach(vote => {
    (vote.slots || []).forEach(slot => {
      const key = `${slot.day}|${slot.time}`;
      slotCount[key] = (slotCount[key] || 0) + 1;
    });
  });

  return {
    totalVotes: votes.length,
    slotCount
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


export const saveRaceHistory = async (
  raceNumber: number,
  trackName: string,
  scheduledDate: Date,
  scheduledDay: string,
  scheduledTime: string,
  confirmedPilots: string[],
  environment: 'PROD' | 'DEV'
): Promise<boolean> => {
  const client = getClient(environment);
  
  const { error } = await client
    .from('race_history')
    .insert({
      race_number: raceNumber,
      track_name: trackName,
      scheduled_date: scheduledDate.toISOString(),
      scheduled_day: scheduledDay,
      scheduled_time: scheduledTime,
      confirmed_pilots: confirmedPilots,
      race_completed: false,
      race_results: [],
      environment: environment  // ← AGREGAR ESTA LÍNEA
    });

  if (error) {
    console.error('Error saving race history:', error);
    return false;
  }

  return true;
};

export const updateRaceResults = async (
  raceNumber: number,
  results: RaceResult[],
  environment: 'PROD' | 'TEST' | 'DEV'
): Promise<boolean> => {
  const client = getClient(environment);
  
  if (!client) {
    console.error('Supabase client not initialized');
    return false;
  }

  // Si race_number es -1, significa que es una carrera manual nueva
  // En ese caso, debemos crear un nuevo registro
  if (raceNumber === -1) {
    console.error('Cannot update race with race_number -1. Use saveRaceHistory to create new races.');
    return false;
  }

  console.log('Updating race results:', { raceNumber, environment, resultsCount: results.length });

  const { data, error } = await client
    .from('race_history')
    .update({
      race_completed: true,
      race_results: results,
      completed_at: new Date().toISOString()
    })
    .eq('race_number', raceNumber)
    .eq('environment', environment)  // ← AGREGAR FILTRO POR ENVIRONMENT
    .select();  // ← AGREGAR SELECT PARA VER QUÉ SE ACTUALIZÓ

  if (error) {
    console.error('Error updating race results:', error);
    return false;
  }

  if (!data || data.length === 0) {
    console.warn('No race found to update with race_number:', raceNumber, 'and environment:', environment);
    return false;
  }

  console.log('Race results updated successfully:', data[0]);
  return true;
};

// Nueva función para crear o actualizar una carrera completa
export const upsertRaceResults = async (
  trackName: string,
  results: RaceResult[],
  environment: 'PROD' | 'TEST' | 'DEV',
  raceId?: string,
  sessionInfo?: any,
  relevantData?: any
): Promise<{ success: boolean; race?: RaceHistory }> => {
  const client = getClient(environment);
  
  if (!client) {
    console.error('Supabase client not initialized');
    return { success: false };
  }

  console.log('Upserting race results:', { trackName, environment, resultsCount: results.length, raceId });

  try {
    // Si tenemos un ID, intentar actualizar
    if (raceId && !raceId.startsWith('manual-')) {
      const { data: existing } = await client
        .from('race_history')
        .select('*')
        .eq('id', raceId)
        .eq('environment', environment)
        .single();

      if (existing) {
        // Actualizar el registro existente
        const { data, error } = await client
          .from('race_history')
          .update({
            race_completed: true,
            race_results: results,
            completed_at: new Date().toISOString(),
            session_info: sessionInfo || existing.session_info,
            relevant_data: relevantData || existing.relevant_data
          })
          .eq('id', raceId)
          .select()
          .single();

        if (error) {
          console.error('Error updating race:', error);
          return { success: false };
        }

        console.log('Race updated successfully:', data);
        return { success: true, race: data };
      }
    }

    // Si no existe o es manual, crear uno nuevo
    // Buscar el race_number más alto para este environment
    const { data: maxRace } = await client
      .from('race_history')
      .select('race_number')
      .eq('environment', environment)
      .order('race_number', { ascending: false })
      .limit(1)
      .single();

    const nextRaceNumber = (maxRace?.race_number || 0) + 1;

    const newRace = {
      race_number: nextRaceNumber,
      track_name: trackName,
      scheduled_date: new Date().toISOString(),
      scheduled_day: new Date().toLocaleDateString('es-AR', { weekday: 'long' }),
      scheduled_time: new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }),
      confirmed_pilots: results.map(r => r.pilot),
      race_completed: true,
      race_results: results,
      completed_at: new Date().toISOString(),
      environment: environment,
      session_info: sessionInfo,
      relevant_data: relevantData
    };

    const { data, error } = await client
      .from('race_history')
      .insert(newRace)
      .select()
      .single();

    if (error) {
      console.error('Error creating race:', error);
      return { success: false };
    }

    console.log('Race created successfully:', data);
    return { success: true, race: data };
  } catch (err) {
    console.error('Error in upsertRaceResults:', err);
    return { success: false };
  }
};

export const getRaceHistory = async (
  environment: 'PROD' | 'DEV'
): Promise<RaceHistory[]> => {
  const client = getClient(environment);
  
  const { data, error } = await client
    .from('race_history')
    .select('*')
    .eq('environment', environment)  // ← AGREGAR ESTA LÍNEA
    .order('race_number', { ascending: false });

  if (error) {
    console.error('Error fetching race history:', error);
    return [];
  }

  console.log('Race history fetched:', data); // ← Debug
  return data || [];
};

export const getRaceByNumber = async (
  raceNumber: number,
  environment: 'PROD' | 'TEST'
): Promise<RaceHistory | null> => {
  const client = getClient(environment);
  
  const { data, error } = await client
    .from('race_history')
    .select('*')
    .eq('race_number', raceNumber)
    .single();

  if (error) {
    console.error('Error fetching race:', error);
    return null;
  }

  return data;
};