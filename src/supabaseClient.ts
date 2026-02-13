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

// Helper: normalize race objects returned by Supabase so the UI can rely on
// snake_case properties (relevant_data, session_info) even if the DB/SDK
// or external input returned camelCase names (relevantData, sessionInfo).
const normalizeRace = (r: any): RaceHistory | null => {
  if (!r) return null;

  // If the API returned camelCase fields, mirror them to snake_case expected by UI
  if (r.relevantData && !r.relevant_data) {
    r.relevant_data = r.relevantData;
  }
  if (r.sessionInfo && !r.session_info) {
    r.session_info = r.sessionInfo;
  }

  // Also ensure nested race_results is an array
  if (!r.race_results && Array.isArray(r.raceResults)) {
    r.race_results = r.raceResults;
  }

  return r as RaceHistory;
};

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

// Obtener votos relevantes para la próxima carrera
// Filtra por timestamp usando la fecha de inicio de votación (guardada en localStorage
// como 'palporro_voting_start') o, en su defecto, calcula el último viernes 23:00
// en zona local. Esto permite ignorar votos antiguos sin modificar la base de datos.
export async function getRelevantVotes(environment: string = 'TEST'): Promise<VoteData[]> {
  try {
    const all = await getVotes(environment);

    // Determinar cutoff
    let cutoff: Date | null = null;
    try {
      // Respeta un override de desarrollo si está activado
      const devEnabled = typeof localStorage !== 'undefined' ? localStorage.getItem('palporro_dev_cutoff_enabled') === '1' : false;
      const devIso = typeof localStorage !== 'undefined' ? localStorage.getItem('palporro_dev_cutoff') : null;
      if (devEnabled && devIso) {
        cutoff = new Date(devIso);
      } else {
        const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('palporro_voting_start') : null;
        if (stored) cutoff = new Date(stored);
      }
    } catch (e) {
      // ignore localStorage errors
    }

    if (!cutoff) {
      // Calcular último viernes a las 23:00 hora local
      const now = new Date();
      const day = now.getDay(); // 0=Sun .. 5=Fri .. 6=Sat
      // días desde el último viernes
      const daysSinceFri = (day >= 5) ? day - 5 : (7 - (5 - day));
      const lastFri = new Date(now);
      lastFri.setDate(now.getDate() - daysSinceFri);
      lastFri.setHours(23, 0, 0, 0);
      cutoff = lastFri;
    }

    const cutoffTs = cutoff.getTime();

    // Debug logs para inspeccionar por qué el filtro no cambia en dev
    try {
      const sample = (all || []).slice(0,5).map((v: any) => ({ pilot: v.pilot, timestamp: v.timestamp, created_at: v.created_at }));
      console.debug('getRelevantVotes:', { environment, cutoff: cutoff.toISOString(), cutoffTs, totalFetched: (all || []).length, sample });
    } catch (e) { /* ignore */ }

    // Filtrar votos cuyo timestamp (ms) sea posterior o igual al cutoff.
    // Si no tenemos timestamp numérico, intentar usar created_at (si existe).
    // Si no hay forma de determinar fecha, excluir el voto para evitar que
    // votos "sin fecha" bloqueen el filtrado.
    const filtered = (all || []).filter(v => {
      if (!v) return false;
      // Preferimos timestamp explícito (ms)
      const ts = typeof v.timestamp === 'number' ? v.timestamp : parseInt(String(v.timestamp || '0')) || 0;
      if (ts && ts >= cutoffTs) return true;

      // Fallback: si la fila tiene created_at (Supabase), usarla
      const createdAtRaw = (v as any).created_at || (v as any).createdAt || null;
      if (createdAtRaw) {
        const createdTs = Date.parse(String(createdAtRaw));
        if (!isNaN(createdTs) && createdTs >= cutoffTs) return true;
      }

      // No podemos confirmar que el voto sea reciente -> excluir
      return false;
    });

    return filtered;
  } catch (err) {
    console.error('getRelevantVotes error:', err);
    return [];
  }
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
        const votes = await getRelevantVotes(environment);
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
  console.log('saveRaceHistory: environment, raceNumber, trackName', { environment, raceNumber, trackName });
  
  const { data: insertResult, error } = await client
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

  console.log('saveRaceHistory: insertResult', insertResult);

  return true;
};

// Archivado: crear race_history + mover votos actuales a race_votes y eliminar de palporro_votes
export const archiveRaceAndMoveVotes = async (
  raceNumber: number,
  trackName: string,
  scheduledDate: Date,
  scheduledDay: string,
  scheduledTime: string,
  confirmedPilots: string[],
  votesToArchive: VoteData[],
  environment: 'PROD' | 'DEV' | 'TEST'
): Promise<boolean> => {
  const client = getClient(environment);
  if (!client) {
    console.error('Supabase client not initialized');
    return false;
  }

  try {
    // 1) Crear el registro en race_history y obtener el id
    const { data: inserted, error: errInsert } = await client
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
        environment: environment
      })
      .select()
      .single();

    if (errInsert || !inserted) {
      console.error('Error inserting race_history during archive:', errInsert);
      return false;
    }

    const raceId = (inserted as any).id;

    // 2) Insertar votos en race_votes (histórico)
    if (Array.isArray(votesToArchive) && votesToArchive.length > 0) {
      // Preserve each vote's original environment when archiving. If a vote row
      // lacks an environment field, fall back to the environment argument.
      const toInsert = votesToArchive.map(v => ({
        race_id: raceId,
        pilot: v.pilot,
        slots: v.slots || [],
        ip: v.ip || null,
        timestamp: v.timestamp || null,
        environment: (v as any).environment || environment
      }));

      try {
        console.log('archiveRaceAndMoveVotes: inserting into race_votes', { raceId, count: toInsert.length, sample: toInsert.slice(0, 5) });
        const { data: insertedVotes, error: errArchive } = await client.from('race_votes').insert(toInsert).select();
        if (errArchive) {
          console.error('Error inserting into race_votes:', errArchive);
        } else {
          console.log('archiveRaceAndMoveVotes: inserted votes into race_votes', { insertedCount: Array.isArray(insertedVotes) ? insertedVotes.length : 0 });
        }
      } catch (e) {
        console.error('archiveRaceAndMoveVotes: exception inserting into race_votes', e);
      }

      // 3) Eliminar votos archivados de la tabla activa para resetear votación
      try {
        // Delete votes grouped by their original environment to avoid removing
        // rows from the wrong environment. This handles mixed-environment inputs
        // gracefully and preserves separation between PROD/TEST/DEV.
        const envGroups: Record<string, string[]> = {};
        votesToArchive.forEach(v => {
          const ev = ((v as any).environment) || environment;
          envGroups[ev] = envGroups[ev] || [];
          envGroups[ev].push(v.pilot);
        });

        for (const ev of Object.keys(envGroups)) {
          const pilots = envGroups[ev];
          console.log('archiveRaceAndMoveVotes: deleting from palporro_votes for environment', ev, { pilots });
          const { data: deletedRows, error: errDel } = await client
            .from('palporro_votes')
            .delete()
            .in('pilot', pilots)
            .eq('environment', ev)
            .select();

          if (errDel) {
            console.error('Error deleting palporro_votes during archive for environment ' + ev + ':', errDel);
          } else {
            console.log('archiveRaceAndMoveVotes: deleted rows from palporro_votes', { env: ev, deletedCount: Array.isArray(deletedRows) ? deletedRows.length : 0 });
          }
        }
      } catch (e) {
        console.error('Failed deleting palporro_votes during archive:', e);
      }
    }

    return true;
  } catch (err) {
    console.error('archiveRaceAndMoveVotes error:', err);
    return false;
  }
};

// Mover votos a una carrera existente (no crea un nuevo race_history)
export const moveVotesToRace = async (
  raceId: string,
  votesToArchive: VoteData[],
  environment: 'PROD' | 'DEV' | 'TEST'
): Promise<boolean> => {
  const client = getClient(environment);
  if (!client) {
    console.error('Supabase client not initialized');
    return false;
  }

  try {
    if (!raceId) {
      console.error('moveVotesToRace: missing raceId');
      return false;
    }

    if (!Array.isArray(votesToArchive) || votesToArchive.length === 0) {
      console.log('moveVotesToRace: no votes to archive');
      return true;
    }

    const toInsert = votesToArchive.map(v => ({
      race_id: raceId,
      pilot: v.pilot,
      slots: v.slots || [],
      ip: v.ip || null,
      timestamp: v.timestamp || null,
      environment
    }));

    try {
      console.log('moveVotesToRace: inserting into race_votes', { raceId, count: toInsert.length, sample: toInsert.slice(0,5) });
      const { data: insertedVotes, error: errArchive } = await client.from('race_votes').insert(toInsert).select();
      if (errArchive) {
        console.error('moveVotesToRace: Error inserting into race_votes:', errArchive);
      } else {
        console.log('moveVotesToRace: inserted votes into race_votes', { insertedCount: Array.isArray(insertedVotes) ? insertedVotes.length : 0 });
      }
    } catch (e) {
      console.error('moveVotesToRace: exception inserting into race_votes', e);
    }

    // Eliminar votos archivados de la tabla activa para resetear votación
    try {
      const pilots = votesToArchive.map(v => v.pilot);
      console.log('moveVotesToRace: deleting from palporro_votes', { pilots, environment });
      const { data: deletedRows, error: errDel } = await client
        .from('palporro_votes')
        .delete()
        .in('pilot', pilots)
        .eq('environment', environment)
        .select();

      if (errDel) {
        console.error('moveVotesToRace: Error deleting palporro_votes during archive:', errDel);
      } else {
        console.log('moveVotesToRace: deleted rows from palporro_votes', { deletedCount: Array.isArray(deletedRows) ? deletedRows.length : 0 });
      }
    } catch (e) {
      console.error('moveVotesToRace: Failed deleting palporro_votes during archive:', e);
    }

    return true;
  } catch (err) {
    console.error('moveVotesToRace error:', err);
    return false;
  }
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

  console.log('updateRaceResults: matched/updated rows', data);

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
  environment: 'PROD' | 'DEV' | 'TEST'
): Promise<RaceHistory[]> => {
  const client = getClient(environment);
  if (!client) {
    console.error('Supabase client not initialized in getRaceHistory');
    return [];
  }

  const { data, error } = await client
    .from('race_history')
    .select('*')
    .eq('environment', environment)
    .order('race_number', { ascending: false });

  if (error) {
    console.error('Error fetching race history:', error);
    return [];
  }

  console.log('Race history fetched:', data);
  // Normalize each race
  return (data || []).map((r: any) => normalizeRace(r)).filter(Boolean) as RaceHistory[];
};

export const getRaceByNumber = async (
  raceNumber: number,
  environment: 'PROD' | 'TEST'
): Promise<RaceHistory | null> => {
  const client = getClient(environment);
  if (!client) {
    console.error('Supabase client not initialized in getRaceByNumber');
    return null;
  }

  const { data, error } = await client
    .from('race_history')
    .select('*')
    .eq('race_number', raceNumber)
    .eq('environment', environment)
    .single();

  if (error) {
    console.error('Error fetching race:', error);
    return null;
  }

  return normalizeRace(data);
};

export const getRaceById = async (
  id: string,
  environment: 'PROD' | 'DEV' | 'TEST'
): Promise<RaceHistory | null> => {
  const client = getClient(environment);
  if (!client) return null;

  const { data, error } = await client
    .from('race_history')
    .select('*')
    .eq('id', id)
    .eq('environment', environment)
    .single();

  if (error) {
    console.error('Error fetching race by id:', error);
    return null;
  }

  // Normalize shape to ensure UI finds relevant_data/session_info
  return normalizeRace(data);
};

// ============================================
// STANDINGS FUNCTIONS
// ============================================

export interface StandingRecord {
  id?: string;
  pilot: string;
  points: number;
  races_run: number;
  last_result: string;
  incidences: number;
  wins: number;
  environment: string;
  updated_at?: string;
}

export const getStandings = async (
  environment: 'PROD' | 'DEV' | 'TEST'
): Promise<StandingRecord[]> => {
  const client = getClient(environment);
  
  if (!client) {
    console.error('Supabase client not initialized');
    return [];
  }

  const { data, error } = await client
    .from('standings')
    .select('*')
    .eq('environment', environment)
    .order('points', { ascending: false });

  if (error) {
    console.error('Error fetching standings:', error);
    return [];
  }

  return data || [];
};

export const upsertStandings = async (
  standings: StandingRecord[],
  environment: 'PROD' | 'DEV' | 'TEST'
): Promise<boolean> => {
  const client = getClient(environment);
  
  if (!client) {
    console.error('Supabase client not initialized');
    return false;
  }

  const records = standings.map(s => ({
    pilot: s.pilot,
    points: s.points,
    races_run: s.races_run,
    last_result: s.last_result,
    incidences: s.incidences,
    wins: s.wins || 0,
    environment: environment,
    updated_at: new Date().toISOString()
  }));

  console.log('📤 Upserting standings to Supabase:', records);

  const { data, error } = await client
    .from('standings')
    .upsert(records, {
      onConflict: 'pilot,environment'
    })
    .select();

  if (error) {
    console.error('❌ Error upserting standings:', error);
    return false;
  }

  console.log('✅ Standings saved successfully to Supabase:', data);
  return true;
};
