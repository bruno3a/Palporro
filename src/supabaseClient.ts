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
  isNoShow?: boolean;
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
  session_info?: {
    track?: string;
    format?: string;
    formato?: string;
    vehicle?: string;
  };
  relevant_data?: {
    performance?: string;
    summary?: string;
    [key: string]: any;
  };
  environment?: string;
}

// Helper: normalize race objects returned by Supabase so the UI can rely on
// snake_case properties (relevant_data, session_info) even if the DB/SDK
// or external input returned camelCase names (relevantData, sessionInfo).
const normalizeRace = (r: any): RaceHistory | null => {
  if (!r) return null;

  if (r.relevantData && !r.relevant_data) r.relevant_data = r.relevantData;
  if (r.sessionInfo && !r.session_info) r.session_info = r.sessionInfo;
  if (!r.race_results && Array.isArray(r.raceResults)) r.race_results = r.raceResults;

  return r as RaceHistory;
};

export let supabase = (supabaseUrl && supabaseAnonKey)
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;

// NOTA: Usamos UN SOLO cliente Supabase para todos los entornos.
// La separación PROD/TEST/DEV se hace mediante la columna `environment` en cada tabla.
// NO se usan proyectos o clientes distintos por entorno.
const getClient = (_environment: string) => {
  return supabase;
};

export function getEnvironment(): string {
  const envFromBuild = (import.meta as any).env?.VITE_ENVIRONMENT;
  const envFromRuntime = runtimeConfig?.VITE_ENVIRONMENT;
  const raw = String(envFromBuild || envFromRuntime || 'PROD');

  let normalized = raw;
  try {
    const up = raw.toUpperCase();
    if (up.includes('PROD')) normalized = 'PROD';
    else if (up.includes('TEST')) normalized = 'TEST';
    else if (up.includes('DEV')) normalized = 'DEV';
    else normalized = raw;
  } catch (e) {
    normalized = raw;
  }

  try {
    console.log('getEnvironment: build=', envFromBuild, 'runtime=', envFromRuntime, '-> raw=', raw, 'normalized=', normalized);
  } catch (e) { /* ignore */ }

  return normalized;
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
export async function getVotes(environment: string = 'PROD'): Promise<VoteData[]> {
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
export async function getRelevantVotes(environment: string = 'PROD'): Promise<VoteData[]> {
  try {
    const all = await getVotes(environment);

    let cutoff: Date | null = null;
    try {
      const devEnabled = typeof localStorage !== 'undefined' ? localStorage.getItem('palporro_dev_cutoff_enabled') === '1' : false;
      const devIso = typeof localStorage !== 'undefined' ? localStorage.getItem('palporro_dev_cutoff') : null;
      if (devEnabled && devIso) {
        cutoff = new Date(devIso);
      } else {
        const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('palporro_voting_start') : null;
        if (stored) cutoff = new Date(stored);
      }
    } catch (e) { /* ignore */ }

    if (!cutoff) {
      const now = new Date();
      const day = now.getDay();
      const daysSinceFri = (day >= 5) ? day - 5 : (7 - (5 - day));
      const lastFri = new Date(now);
      lastFri.setDate(now.getDate() - daysSinceFri);
      lastFri.setHours(23, 0, 0, 0);
      cutoff = lastFri;
    }

    const cutoffTs = cutoff.getTime();

    const filtered = (all || []).filter(v => {
      if (!v) return false;
      const ts = typeof v.timestamp === 'number' ? v.timestamp : parseInt(String(v.timestamp || '0')) || 0;
      if (ts && ts >= cutoffTs) return true;
      const createdAtRaw = (v as any).created_at || (v as any).createdAt || null;
      if (createdAtRaw) {
        const createdTs = Date.parse(String(createdAtRaw));
        if (!isNaN(createdTs) && createdTs >= cutoffTs) return true;
      }
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
  environment: string = 'PROD'
): Promise<boolean> {
  if (supabase) {
    try {
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

      if (!error) return true;
      console.error('Error adding vote via supabase-js client:', error);
    } catch (err) {
      console.error('Supabase client upsert error:', err);
    }
  }

  // REST fallback
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

      if (resp.ok) return true;
      const body = await resp.text().catch(() => '');
      console.error('addVote: REST fallback failed', resp.status, body);
      return false;
    } catch (err) {
      console.error('addVote: REST fallback error', err);
      return false;
    }
  }

  return false;
}

// Suscribirse a cambios en tiempo real
export function subscribeToVotes(
  environment: string,
  callback: (votes: VoteData[]) => void
) {
  if (!supabase) return () => {};

  const channel = supabase
    .channel(`palporro-votes-changes-${environment}`)
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

// Obtener estadísticas de votación
export async function getVotingStats(environment: string = 'PROD') {
  const votes = await getVotes(environment);
  const slotCount: Record<string, number> = {};
  votes.forEach(vote => {
    (vote.slots || []).forEach(slot => {
      const key = `${slot.day}|${slot.time}`;
      slotCount[key] = (slotCount[key] || 0) + 1;
    });
  });
  return { totalVotes: votes.length, slotCount };
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

// ============================================
// RACE HISTORY FUNCTIONS
// NOTA: PROD y TEST usan la MISMA tabla race_history, diferenciada por la columna `environment`.
// ============================================

export const saveRaceHistory = async (
  raceNumber: number,
  trackName: string,
  scheduledDate: Date,
  scheduledDay: string,
  scheduledTime: string,
  confirmedPilots: string[],
  environment: 'PROD' | 'TEST' | 'DEV'
): Promise<boolean> => {
  const client = getClient(environment);
  if (!client) {
    console.error('Supabase client not initialized');
    return false;
  }

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
      environment
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
        environment
      })
      .select()
      .single();

    if (errInsert || !inserted) {
      console.error('Error inserting race_history during archive:', errInsert);
      return false;
    }

    const raceId = (inserted as any).id;

    if (Array.isArray(votesToArchive) && votesToArchive.length > 0) {
      const toInsert = votesToArchive.map(v => ({
        race_id: raceId,
        pilot: v.pilot,
        slots: v.slots || [],
        ip: v.ip || null,
        timestamp: v.timestamp || null,
        environment: (v as any).environment || environment
      }));

      try {
        const { error: errArchive } = await client.from('race_votes').insert(toInsert);
        if (errArchive) console.error('Error inserting into race_votes:', errArchive);
      } catch (e) {
        console.error('archiveRaceAndMoveVotes: exception inserting into race_votes', e);
      }

      try {
        const envGroups: Record<string, string[]> = {};
        votesToArchive.forEach(v => {
          const ev = ((v as any).environment) || environment;
          envGroups[ev] = envGroups[ev] || [];
          envGroups[ev].push(v.pilot);
        });

        for (const ev of Object.keys(envGroups)) {
          const pilots = envGroups[ev];
          const { error: errDel } = await client
            .from('palporro_votes')
            .delete()
            .in('pilot', pilots)
            .eq('environment', ev);

          if (errDel) console.error('Error deleting palporro_votes during archive for env ' + ev + ':', errDel);
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
  if (!client) return false;

  try {
    if (!raceId) return false;
    if (!Array.isArray(votesToArchive) || votesToArchive.length === 0) return true;

    const toInsert = votesToArchive.map(v => ({
      race_id: raceId,
      pilot: v.pilot,
      slots: v.slots || [],
      ip: v.ip || null,
      timestamp: v.timestamp || null,
      environment
    }));

    const { error: errArchive } = await client.from('race_votes').insert(toInsert);
    if (errArchive) console.error('moveVotesToRace: Error inserting into race_votes:', errArchive);

    const pilots = votesToArchive.map(v => v.pilot);
    const { error: errDel } = await client
      .from('palporro_votes')
      .delete()
      .in('pilot', pilots)
      .eq('environment', environment);

    if (errDel) console.error('moveVotesToRace: Error deleting palporro_votes:', errDel);

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
  if (!client) return false;
  if (raceNumber === -1) return false;

  const { data, error } = await client
    .from('race_history')
    .update({
      race_completed: true,
      race_results: results,
      completed_at: new Date().toISOString()
    })
    .eq('race_number', raceNumber)
    .eq('environment', environment)
    .select();

  if (error) { console.error('Error updating race results:', error); return false; }
  if (!data || data.length === 0) return false;
  return true;
};

// ============================================
// upsertRaceResults
// PROD y TEST usan la MISMA tabla race_history, diferenciadas por la columna `environment`.
// ============================================
export const upsertRaceResults = async (
  trackName: string,
  results: RaceResult[],
  environment: 'PROD' | 'TEST' | 'DEV',
  raceId?: string,
  sessionInfo?: any,
  relevantData?: any
): Promise<{ success: boolean; race?: RaceHistory }> => {
  const client = getClient(environment);
  if (!client) return { success: false };

  console.log('upsertRaceResults:', { trackName, environment, resultsCount: results.length, raceId });

  try {
    // Si tenemos un ID real (no generado localmente con prefijos manual-/empty-)
    const isLocalId = !raceId || raceId.startsWith('manual-') || raceId.startsWith('empty-');

    if (raceId && !isLocalId) {
      const { data: existing } = await client
        .from('race_history')
        .select('*')
        .eq('id', raceId)
        .eq('environment', environment)
        .single();

      if (existing) {
        const { data, error } = await client
          .from('race_history')
          .update({
            race_completed: true,
            race_results: results,
            completed_at: new Date().toISOString(),
            session_info: sessionInfo ?? existing.session_info ?? null,
            relevant_data: relevantData ?? existing.relevant_data ?? null
          })
          .eq('id', raceId)
          .eq('environment', environment)
          .select()
          .single();

        if (error) { console.error('Error updating race:', error); return { success: false }; }
        console.log('Race updated successfully:', data);
        return { success: true, race: normalizeRace(data) as RaceHistory };
      }
    }

    // Crear nuevo registro
    const { data: maxRace } = await client
      .from('race_history')
      .select('race_number')
      .eq('environment', environment)
      .order('race_number', { ascending: false })
      .limit(1)
      .maybeSingle();

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
      environment,
      session_info: sessionInfo ?? null,
      relevant_data: relevantData ?? null
    };

    const { data, error } = await client
      .from('race_history')
      .insert(newRace)
      .select()
      .single();

    if (error) { console.error('Error creating race:', error); return { success: false }; }
    console.log('Race created successfully:', data);
    return { success: true, race: normalizeRace(data) as RaceHistory };
  } catch (err) {
    console.error('Error in upsertRaceResults:', err);
    return { success: false };
  }
};

export const getRaceHistory = async (
  environment: 'PROD' | 'DEV' | 'TEST'
): Promise<RaceHistory[]> => {
  const client = getClient(environment);
  if (!client) return [];

  const { data, error } = await client
    .from('race_history')
    .select('*')
    .eq('environment', environment)
    .order('race_number', { ascending: false });

  if (error) { console.error('Error fetching race history:', error); return []; }

  return (data || []).map((r: any) => normalizeRace(r)).filter(Boolean) as RaceHistory[];
};

export const getRaceByNumber = async (
  raceNumber: number,
  environment: 'PROD' | 'TEST'
): Promise<RaceHistory | null> => {
  const client = getClient(environment);
  if (!client) return null;

  const { data, error } = await client
    .from('race_history')
    .select('*')
    .eq('race_number', raceNumber)
    .eq('environment', environment)
    .single();

  if (error) { console.error('Error fetching race:', error); return null; }
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

  if (error) { console.error('Error fetching race by id:', error); return null; }
  return normalizeRace(data);
};

// ============================================
// STANDINGS FUNCTIONS
// NOTA: PROD y TEST usan la MISMA tabla standings, diferenciadas por la columna `environment`.
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
  if (!client) return [];

  const { data, error } = await client
    .from('standings')
    .select('*')
    .eq('environment', environment)
    .order('points', { ascending: false });

  if (error) { console.error('Error fetching standings:', error); return []; }
  return data || [];
};

export const upsertStandings = async (
  standings: Omit<StandingRecord, 'environment' | 'id' | 'updated_at'>[],
  environment: 'PROD' | 'DEV' | 'TEST'
): Promise<boolean> => {
  const client = getClient(environment);
  if (!client) return false;

  const records = standings.map(s => ({
    pilot: s.pilot,
    points: s.points,
    races_run: s.races_run,
    last_result: s.last_result,
    incidences: s.incidences,
    wins: s.wins || 0,
    environment,
    updated_at: new Date().toISOString()
  }));

  console.log('📤 Upserting standings to Supabase:', records);

  const { data, error } = await client
    .from('standings')
    .upsert(records, { onConflict: 'pilot,environment' })
    .select();

  if (error) { console.error('❌ Error upserting standings:', error); return false; }
  console.log('✅ Standings saved successfully:', data);
  return true;
};

// ============================================
// VISIT COUNTER FUNCTIONS
//
// Lógica: una visita se contabiliza por IP + día calendario (zona AR).
// - Si la misma IP ya visitó hoy → no incrementa, solo devuelve el total.
// - Si es una IP nueva O la misma IP pero en un día distinto → incrementa.
//
// Requiere en Supabase:
//   Tabla: visit_log      (ip TEXT, visit_date DATE, environment TEXT, PRIMARY KEY (ip, visit_date, environment))
//   Tabla: visit_counter  (environment TEXT PRIMARY KEY, count INT, last_updated TIMESTAMPTZ)
//   Función RPC: register_visit(p_ip TEXT, p_date DATE, p_env TEXT) → INT
//     (ver SQL completo en el comentario al final de este archivo)
// ============================================

/**
 * Registra una visita si es la primera de esta IP hoy (hora AR).
 * Devuelve el total actualizado de visitas únicas.
 */
export async function incrementVisits(
  environment: 'PROD' | 'TEST' = 'PROD',
  ip?: string
): Promise<{ counted: boolean; total: number }> {
  const fallback = { counted: false, total: 0 };
  try {
    const client = getClient(environment);
    if (!client || !ip) return fallback;

    // Fecha del día actual en zona horaria Argentina (UTC-3)
    const arDate = new Date(
      new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' })
    );
    const visitDate = arDate.toISOString().slice(0, 10); // "YYYY-MM-DD"

    // Llamar a la función RPC que hace el upsert atómico y devuelve el total
    const { data, error } = await client.rpc('register_visit', {
      p_ip: ip,
      p_date: visitDate,
      p_env: environment
    });

    if (error) {
      console.error('Error registering visit:', error);
      return fallback;
    }

    // data es el nuevo total de visitas únicas
    const total = typeof data === 'number' ? data : 0;
    console.log('👁️ Visita registrada:', { ip, visitDate, environment, total });
    return { counted: true, total };
  } catch (err) {
    console.error('Exception in incrementVisits:', err);
    return fallback;
  }
}

/**
 * Obtiene el total actual de visitas únicas (IP+día) para el entorno.
 */
export async function getVisitCount(environment: 'PROD' | 'TEST' = 'PROD'): Promise<number> {
  try {
    const client = getClient(environment);
    if (!client) return 0;

    const { data, error } = await client
      .from('visit_counter')
      .select('count')
      .eq('environment', environment)
      .single();

    if (error) return 0;
    return data?.count || 0;
  } catch (err) {
    return 0;
  }
}

/*
══════════════════════════════════════════════════════════════
SQL A EJECUTAR EN SUPABASE (SQL Editor)
══════════════════════════════════════════════════════════════

-- 1. Tabla de log de visitas individuales (IP + día + environment)
CREATE TABLE IF NOT EXISTS visit_log (
  ip          TEXT        NOT NULL,
  visit_date  DATE        NOT NULL,
  environment TEXT        NOT NULL DEFAULT 'PROD',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (ip, visit_date, environment)
);

-- 2. Tabla de totales (una fila por environment)
CREATE TABLE IF NOT EXISTS visit_counter (
  environment  TEXT        PRIMARY KEY,
  count        BIGINT      NOT NULL DEFAULT 0,
  last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed inicial si no existe
INSERT INTO visit_counter (environment, count)
VALUES ('PROD', 0), ('TEST', 0)
ON CONFLICT (environment) DO NOTHING;

-- 3. Función RPC atómica: registra visita si es nueva (IP+día), incrementa contador
CREATE OR REPLACE FUNCTION register_visit(
  p_ip   TEXT,
  p_date DATE,
  p_env  TEXT
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_new  BOOLEAN := FALSE;
  v_total BIGINT;
BEGIN
  -- Intentar insertar. Si ya existe (PK duplicada) → no hacer nada.
  INSERT INTO visit_log (ip, visit_date, environment)
  VALUES (p_ip, p_date, p_env)
  ON CONFLICT (ip, visit_date, environment) DO NOTHING;

  -- GET DIAGNOSTICS devuelve cuántas filas se insertaron realmente
  GET DIAGNOSTICS v_new = ROW_COUNT;

  IF v_new > 0 THEN
    -- Es una visita nueva: incrementar el contador total
    INSERT INTO visit_counter (environment, count, last_updated)
    VALUES (p_env, 1, NOW())
    ON CONFLICT (environment)
    DO UPDATE SET
      count        = visit_counter.count + 1,
      last_updated = NOW();
  END IF;

  -- Devolver el total actualizado
  SELECT count INTO v_total FROM visit_counter WHERE environment = p_env;
  RETURN COALESCE(v_total, 0);
END;
$$;

-- 4. RLS: la función usa SECURITY DEFINER, así que los clientes anon
--    pueden llamarla sin necesitar permisos directos en las tablas.
--    Pero igualmente concedemos execute para el rol anon:
GRANT EXECUTE ON FUNCTION register_visit(TEXT, DATE, TEXT) TO anon;

══════════════════════════════════════════════════════════════
*/