import React, { useState, useRef, useMemo, useEffect } from 'react';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleGenAI } from '@google/genai';
import { PILOTS, INITIAL_TRACKS, SCRIPT_SYSTEM_INSTRUCTION_DYNAMIC, VOICE_OPTIONS, ARTISTIC_ALIASES } from './constants';
import { decode, encode, decodeAudioData, createWavBlob } from './audioUtils';
import { TrackStatus, Standing } from './types';
import {
  getVotes, addVote, subscribeToVotes, getEnvironment,
  getRelevantVotes, TimeSlot, archiveRaceAndMoveVotes,
  saveRaceHistory, getRaceHistory, upsertRaceResults,
  getStandings, upsertStandings, getRaceById,
  moveVotesToRace, incrementVisits, getVisitCount,
  RaceHistory, RaceResult,
  getPinnedTrack, pinNextTrack, subscribeToNextTrack
} from "./src/supabaseClient";

//import { getPinnedTrack, pinNextTrack, subscribeToNextTrack } from "./src/supabaseClient.extra";
import { normalizeRaceResults, getUnmappedPilots } from './PilotMapping';

interface VoteData {
  slots: TimeSlot[];
  pilot: string;
  ip?: string;
  timestamp: number;
}

interface VotingState {
  isOpen: boolean;
  hasVoted: boolean;
  selectedSlots: TimeSlot[];
  selectedDays: string[];
  selectedTimes: string[];
  userPilot: string | null;
  allVotes: VoteData[];
}

const VOTING_DAYS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes'];
const VOTING_TIMES = ['18:00', '18:30', '19:00', '19:30', '20:00', '20:30', '22:00', '22:30', '23:00'];

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'radio' | 'history'>('dashboard');
  const [raceHistory, setRaceHistory] = useState<RaceHistory[]>([]);
  const [selectedHistoryRace, setSelectedHistoryRace] = useState<RaceHistory | null>(null);
  const [showResultsModal, setShowResultsModal] = useState(false);
  const [radioAccessCode, setRadioAccessCode] = useState('');
  const [isRadioUnlocked, setIsRadioUnlocked] = useState(false);
  // Modal-local code to unlock editing of race results (must enter code here)
  const [resultsCodeInput, setResultsCodeInput] = useState('');
  const [isResultsUnlocked, setIsResultsUnlocked] = useState(false);
  // Inline unlock overlay state for individual history cards
  const [historyUnlockTarget, setHistoryUnlockTarget] = useState<string | null>(null);
  const [historyUnlockInput, setHistoryUnlockInput] = useState('');
  // Editing results state
  const [isEditingResults, setIsEditingResults] = useState(false);
  const [editingResults, setEditingResults] = useState<RaceResult[] | null>(null);
  const [isSavingResults, setIsSavingResults] = useState(false);
  const [showJsonImport, setShowJsonImport] = useState(false);
  const [jsonInput, setJsonInput] = useState('');
  const [sessionInfo, setSessionInfo] = useState<any>(null);
  const [relevantData, setRelevantData] = useState<any>(null);
  const [isAppReady, setIsAppReady] = useState(false);
  const RADIO_CODE = '1290';
  const geminiKey = import.meta.env.VITE_GEMINI_API_KEY
    || (window as any).__PALPORRO_CONFIG?.VITE_GEMINI_API_KEY
    || '';

  
  const [introState, setIntroState] = useState<'gate' | 'playing' | 'done'>(() => {
    try {
      // Si el usuario eligió no volver a ver → saltar para siempre
      if (localStorage.getItem('palporro_intro_skip') === '1') return 'done';
      // Si ya lo vio esta sesión → saltar esta sesión
      if (sessionStorage.getItem('palporro_intro_seen') === '1') return 'done';
      return 'gate';
    } catch(e) { return 'gate'; }
  });
  const [introSkipForever, setIntroSkipForever] = useState<boolean>(() => {
    try { return localStorage.getItem('palporro_intro_skip') === '1'; } catch(e) { return false; }
  });
  const [bgAudioUrl] = useState('/intro-bg.mp3'); // archivo de voz en /public
  const bgAudioRef = useRef<HTMLAudioElement | null>(null);
  const playbackAudioRef = useRef<HTMLAudioElement | null>(null);
  // Agregar estos estados PRIMERO
  const [debugMode, setDebugMode] = useState(false);
  const [forceVotingActive, setForceVotingActive] = useState(false);
  const [visitCount, setVisitCount] = useState<number | null>(null);
  const [useGridVoting, setUseGridVoting] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem('palporro_grid_voting');
      return v == null ? true : v === '1';
    } catch (e) { return true; }
  });
  // TEST: simulate cutoff override
  const [devSimulateCutoff, setDevSimulateCutoff] = useState<boolean>(() => {
    try { return localStorage.getItem('palporro_dev_cutoff_enabled') === '1'; } catch(e) { return false; }
  });
  const [devCutoffIso, setDevCutoffIso] = useState<string>(() => {
    try { return localStorage.getItem('palporro_dev_cutoff') || ''; } catch(e) { return ''; }
  });

  // Ensure Supabase integration uses slots shape. Provide a small migration helper
  // that converts legacy votes with days/times arrays into slots when loading.
  useEffect(() => {
    // When votes are loaded or on mount, migrate any legacy entries in votingState.allVotes
    if (!votingState || !Array.isArray(votingState.allVotes)) return;
    const migrated = votingState.allVotes.map(v => {
      // If already has slots, keep
      if (v.slots && Array.isArray(v.slots)) return v;
      // If legacy shape has days/times, convert
      const days = (v as any).days || [];
      const times = (v as any).times || [];
      if (Array.isArray(days) && Array.isArray(times) && (days.length || times.length)) {
        const slots: any[] = [];
        days.forEach((d: string) => times.forEach((t: string) => slots.push({ day: d, time: t })));
        return { ...v, slots };
      }
      return v;
    });
    // If migration changed something, update state
    const changed = migrated.some((m, i) => m !== votingState.allVotes[i]);
    if (changed) {
      setVotingState(prev => ({ ...prev, allVotes: migrated }));
    }
  }, []);
  const [tracks, setTracks] = useState<TrackStatus[]>(INITIAL_TRACKS.map((t, idx) => ({ name: t, completed: idx === 0 })));

  const [metricsInput, setMetricsInput] = useState("");
  const [analysis, setAnalysis] = useState("");
  const [standings, setStandings] = useState<Standing[]>(PILOTS.map(p => ({ pilot: p, points: 0, lastResult: 'N/A', racesRun: 0, incidences: 0 })));
  const getArtisticName = (realName: string) => {
    // Deterministic pick by hashing the realName so it stays consistent across renders
    let h = 0;
    for (let i = 0; i < realName.length; i++) h = (h << 5) - h + realName.charCodeAt(i) | 0;
    const idx = Math.abs(h) % ARTISTIC_ALIASES.length;
    return ARTISTIC_ALIASES[idx];
  };
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [selectedTrack, setSelectedTrack] = useState<string | null>(null);

  const [scripts, setScripts] = useState<string[]>([]);
  const [activeScriptIdx, setActiveScriptIdx] = useState(0);
  const [selectedVoice, setSelectedVoice] = useState(VOICE_OPTIONS[0].id);
  const [customPrompt, setCustomPrompt] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [isPlayingTTS, setIsPlayingTTS] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [emissionHistory, setEmissionHistory] = useState<Array<{
    id: string;
    script: string;
    voice: string;
    audioUrl: string;
    timestamp: Date;
  }>>([]);
  const [directText, setDirectText] = useState('');

  const [scoringSystem, setScoringSystem] = useState<1 | 2>(() => {
    try { return localStorage.getItem('palporro_scoring_system') === '2' ? 2 : 1; }
    catch(e) { return 1; }
  });
  // Floating player controls
  const [isFloatingMinimized, setIsFloatingMinimized] = useState(() => {
    // En mobile (ancho < 768px), iniciar minimizado para no tapar el footer
    return typeof window !== 'undefined' && window.innerWidth < 768;
  });

  // Apply global custom cursor (useEffect so it works in production build)
  useEffect(() => {
    const prevBody = document.body.style.cursor;
    const prevDoc = document.documentElement.style.cursor;
    // Try to apply custom cursor on both body and html. Some browsers ignore webp cursors,
    // in that case the browser will fall back to 'auto'.
    try {
      // Try PNG first, then WEBP as fallback, then auto. Many browsers prefer PNG for cursors.
      const cursorUrl = "url('/GTR34.png'), url('/GTR34.webp'), auto";
      document.body.style.cursor = cursorUrl;
      document.documentElement.style.cursor = cursorUrl;
    } catch (e) {
      // ignore
    }
    return () => {
      document.body.style.cursor = prevBody;
      document.documentElement.style.cursor = prevDoc;
    };
  }, []);

// Voting state helpers (deduplicated):
// Single source of truth for pending vote changes and helper utilities
const arraysEqual = (a: string[], b: string[]) => {
  if (a.length !== b.length) return false;
  // Compare irrespective of order
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
};

  const [votingState, setVotingState] = useState<VotingState>(() => {
    const saved = localStorage.getItem('palporro_voting');
    if (saved) {
      try {
        const parsed = JSON.parse(saved || '{}');
        return {
          isOpen: parsed.isOpen ?? false,
          hasVoted: parsed.hasVoted ?? false,
          selectedSlots: parsed.selectedSlots ?? [],
          selectedDays: parsed.selectedDays ?? [],
          selectedTimes: parsed.selectedTimes ?? [],
          userPilot: parsed.userPilot ?? localStorage.getItem('palporro_user_pilot'),
          allVotes: parsed.allVotes ?? []
        } as VotingState;
      } catch (e) {
        // fallback
      }
    }

    return {
      isOpen: false,
      hasVoted: false,
      selectedSlots: [],
      selectedDays: [],
      selectedTimes: [],
      userPilot: localStorage.getItem('palporro_user_pilot'),
      allVotes: []
    };
  });

  const [showPilotSelector, setShowPilotSelector] = useState(!votingState.userPilot);
  const [votingStats, setVotingStats] = useState<{
    totalVotes: number;
    dayCount: Record<string, number>;
    timeCount: Record<string, number>;
  } | null>(null);

  // UI/state helpers needed by voting panel
  const [isSubmittingVote, setIsSubmittingVote] = useState(false);
  const [pendingVoteChange, setPendingVoteChange] = useState(false);

  // Keep pendingVoteChange in sync with voting selections for the current pilot
  useEffect(() => {
    const pilot = votingState.userPilot;
    if (!pilot) { setPendingVoteChange(false); return; }
    const existing = votingState.allVotes.find(v => v.pilot === pilot);
    const hasSelection = votingState.selectedSlots.length > 0;
    if (!existing) {
      setPendingVoteChange(hasSelection);
      return;
    }
    const sameSlots = JSON.stringify([...votingState.selectedSlots].sort((a,b) => `${a.day}${a.time}`.localeCompare(`${b.day}${b.time}`)))
      === JSON.stringify([...(existing.slots || [])].sort((a,b) => `${a.day}${a.time}`.localeCompare(`${b.day}${b.time}`)));
    setPendingVoteChange(hasSelection && !sameSlots);
  }, [votingState.selectedSlots, votingState.userPilot, votingState.allVotes]);

  // AHORA definir la función isVotingActive DESPUÉS de los estados
  const isVotingActive = (): boolean => {
    // La votación SIEMPRE está activa - es perpetua
    // Después de cada carrera se resetea y se abre inmediatamente para la siguiente
    return true;
  };

  // Cargar historial al montar el componente
  React.useEffect(() => {
    try {
      const saved = localStorage.getItem('palporro-emissions');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          setEmissionHistory(parsed);
        }
      }
    } catch (error) {
      console.error('Error loading emission history:', error);
    }
  }, []);

  const audioContextRef = useRef<AudioContext | null>(null);

  const completedCount = useMemo(() => tracks.filter(t => t.completed).length, [tracks]);
  const [nextTrackIndex, setNextTrackIndex] = useState<number>(() => {
    // default to first non-completed
    const idx = INITIAL_TRACKS.findIndex((_, i) => i > 0);
    return idx === -1 ? 0 : idx;
  });

  // Elegir aleatoriamente la próxima pista entre las no corridas
  const pickRandomNextTrack = (tracksArr: TrackStatus[], raceHist: RaceHistory[] = []) => {
    try {
      // Si ya hay una pista fijada, respetarla
      const pinned = localStorage.getItem('palporro_next_track');
      if (pinned) {
        const idx = tracksArr.findIndex(t => t.name === pinned);
        if (idx !== -1 && !tracksArr[idx].completed) return idx;
        // Si ya se completó, limpiar y elegir nueva
        localStorage.removeItem('palporro_next_track');
      }

      const completedNames = new Set<string>();
      tracksArr.forEach(t => { if (t.completed) completedNames.add((t.name || '').toLowerCase()); });
      raceHist.forEach(r => { if (r.race_completed && r.track_name) completedNames.add((r.track_name || '').toLowerCase()); });

      const candidates = tracksArr.map((t, i) => ({ t, i })).filter(x => !completedNames.has((x.t.name || '').toLowerCase()));
      if (candidates.length === 0) {
        const fallback = tracksArr.findIndex(t => !t.completed);
        return fallback === -1 ? 0 : fallback;
      }

      // ✅ Random real
      const chosen = candidates[Math.floor(Math.random() * candidates.length)];
      localStorage.setItem('palporro_next_track', chosen.t.name); // fijar para todos
      return chosen.i;
    } catch (e) {
      return tracksArr.findIndex(t => !t.completed) || 0;
    }
  };

  // Helper: Obtener información de la próxima pista (útil para debugging)
  const getCurrentNextTrack = () => {
    if (nextTrackIndex === -1 || !tracks[nextTrackIndex]) {
      return { name: 'Fin de temporada', index: -1 };
    }
    return {
      name: tracks[nextTrackIndex].name,
      index: nextTrackIndex,
      completed: tracks[nextTrackIndex].completed
    };
  };

  // LOG en consola cada vez que cambie nextTrackIndex (para debugging)
  useEffect(() => {
    const info = getCurrentNextTrack();
    console.log('🎯 PRÓXIMA PISTA ACTIVA:', info);
  }, [nextTrackIndex]);

  const fiaScoreData = useMemo(() => {
    if (completedCount === 0) return { value: 0, label: "PENDIENTE", isPending: true };
    const totalPilots = PILOTS.length;
    const totalPotentialStarts = totalPilots * completedCount;
    const actualStarts = standings.reduce((acc, s) => acc + s.racesRun, 0);
    const participationRate = (actualStarts / totalPotentialStarts) * 100;
    const avgPilotsPerRace = actualStarts / completedCount;

    let level = 50;
    if (avgPilotsPerRace <= 3) level = 95; 
    else if (participationRate < 50) level = 85 + (50 - participationRate) / 5;
    else if (participationRate > 70) level = 25;

    return { value: level, label: `${Math.round(level)}%`, isPending: false };
  }, [standings, completedCount]);

  const initAudio = () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    }
    return audioContextRef.current;
  };

  const [floatingPlayerPos, setFloatingPlayerPos] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });

  // Inicializar posición del reproductor flotante al centro-inferior
  useEffect(() => {
    const updatePosition = () => {
      setFloatingPlayerPos({
        x: window.innerWidth / 2 - 200, // 200 = mitad del ancho del reproductor (400px / 2)
        y: window.innerHeight - 250 // 250px desde abajo
      });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    return () => window.removeEventListener('resize', updatePosition);
  }, []);

  const handleMouseDown = (e: React.MouseEvent) => {
    setIsDragging(true);
    setDragOffset({
      x: e.clientX - floatingPlayerPos.x,
      y: e.clientY - floatingPlayerPos.y
    });
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (isDragging) {
      setFloatingPlayerPos({
        x: e.clientX - dragOffset.x,
        y: e.clientY - dragOffset.y
      });
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  useEffect(() => {
    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isDragging, dragOffset]);

  const handleAnalyzeMetrics = async () => {
    if (!metricsInput.trim()) return;
    setIsAnalyzing(true);
    setAnalysis('');

    try {
      const genAI = new GoogleGenerativeAI(geminiKey);
      const model = genAI.getGenerativeModel({
        model: 'gemini-2.5-flash',
        generationConfig: { responseMimeType: 'application/json' }
      });

      const prompt = `Sos un analizador de resultados de carreras de Assetto Corsa. Procesá el JSON raw adjunto y devolvé ÚNICAMENTE un objeto JSON válido, sin markdown ni texto adicional.

═══════════════════════════════════════════
PASO 1 — DETECCIÓN DE FORMATO
═══════════════════════════════════════════
Contá cuántas entradas tiene el piloto más frecuente en el array "Laps" (cada entrada = 1 vuelta completada).
- Si el líder tiene <= 4 vueltas en "Laps" → formato = "Carrera por Tiempo Límite"
- Si el líder tiene > 4 vueltas en "Laps"  → formato = "Carrera por Vueltas"

ATENCIÓN: el array "Result" de AC NO refleja la clasificación correcta — está ordenado por TotalTime, lo cual es incorrecto en carreras por tiempo límite. IGNORÁ el orden de "Result" para clasificar.

═══════════════════════════════════════════
PASO 2 — CONTEO DE VUELTAS (fuente de verdad)
═══════════════════════════════════════════
Para cada piloto, contá cuántas entradas tiene en el array "Laps". Eso es su cantidad real de vueltas.
Ejemplo: si "Ledex" aparece 3 veces en "Laps" → completó 3 vueltas.

═══════════════════════════════════════════
PASO 3 — CLASIFICACIÓN
═══════════════════════════════════════════

SI ES "Carrera por Tiempo Límite":
  Criterio primario:   más vueltas completadas (contadas en "Laps") = mejor posición
  Criterio secundario: si empatan en vueltas → menor TotalTime gana
  
  Estado de cada piloto:
  - "Finalizó"      → completó al menos 1 vuelta (aparece en "Laps")
  - "No presentó"   → 0 vueltas en "Laps" Y TotalTime = 0 en "Result"

SI ES "Carrera por Vueltas":
  Criterio: menor TotalTime entre quienes completaron todas las vueltas
  Estado de cada piloto:
  - "Finalizó"  → tiene TotalTime > 0
  - "Retirado"  → TotalTime = 0

═══════════════════════════════════════════
PASO 4 — TIEMPOS
═══════════════════════════════════════════
- Convertir milisegundos a "M:SS.mmm" (ej: 487521ms → "8:07.521")
- TotalTime = 0 → mostrar como "—"
- BestLap = 999999999 → mostrar como "—"
- Para mejores sectores: recorrer TODO el array "Laps" y tomar el MÍNIMO de cada sector (S1=Sectors[0], S2=Sectors[1], S3=Sectors[2]) por piloto

═══════════════════════════════════════════
PASO 5 — INCIDENTES
═══════════════════════════════════════════
Contar entradas de tipo "COLLISION_WITH_ENV" en "Events" agrupadas por nombre de piloto.

═══════════════════════════════════════════
ESTRUCTURA DE SALIDA
═══════════════════════════════════════════
{
  "sesion_info": {
    "pista": "nombre legible del TrackName",
    "formato": "Carrera por Tiempo Límite | Carrera por Vueltas",
    "vehiculo_unico": "nombre del modelo de auto"
  },
  "clasificacion_completa": [
    {
      "posicion": 1,
      "nombre": "nombre exacto del Driver en Cars[]",
      "vueltas": 3,
      "tiempo_total": "M:SS.mmm o —",
      "mejor_vuelta": "M:SS.mmm o —",
      "mejores_sectores": { "S1": "M:SS.mmm", "S2": "M:SS.mmm", "S3": "M:SS.mmm" },
      "estado": "Finalizó | No presentó | Retirado",
      "incidentes": 0
    }
  ],
  "datos_relevantes": {
    "rendimiento": "párrafo narrativo describiendo el desempeño individual de cada piloto: velocidades, vueltas rápidas, incidentes destacados, comportamiento en pista. Ej: 'Solimo registró la vuelta más rápida (07:31.805) pero no completó las vueltas del líder. Ledex ganó acumulando 17 colisiones contra el entorno.'",
    "resumen_jornada": "párrafo narrativo describiendo el contexto general de la sesión: formato de carrera, condiciones, resultado final y diferencias clave entre pilotos"
  }
}

JSON RAW DE ASSETTO CORSA:
${metricsInput.trim()}`;

      const result = await model.generateContent(prompt);
      const responseText = (result.response.text() || '{}').replace(/```json|```/g, '').trim();
      console.log('🤖 Gemini raw response:', responseText.slice(0, 500));
      const parsedJson = JSON.parse(responseText);

      // Normalizar nombres AC → Palporro
      if (Array.isArray(parsedJson.clasificacion_completa)) {
        const normalizedItems = normalizeRaceResults(parsedJson.clasificacion_completa);
        parsedJson.clasificacion_completa = parsedJson.clasificacion_completa.map((item: any, i: number) => ({
          ...item,
          nombre_original: item.nombre || '',
          nombre: normalizedItems[i]?.normalizedName || item.nombre || '',
        }));
        const unmapped = getUnmappedPilots(
          parsedJson.clasificacion_completa.map((r: any) => r.nombre_original).filter(Boolean)
        );
        if (unmapped.length > 0) console.warn('⚠️ Pilotos sin mapeo AC→Palporro:', unmapped);
      }

      setAnalysis(JSON.stringify(parsedJson, null, 2));
    } catch (err: any) {
      console.error('❌ Error en el proceso:', err);
      const raw = err?.message || String(err);
      setAnalysis(JSON.stringify({
        error: 'Fallo en el procesamiento.',
        detalle: raw,
        tip: raw.includes('JSON') ? 'Gemini no devolvió JSON válido — revisá la consola para ver la respuesta cruda.' : undefined
      }, null, 2));
    } finally {
      setIsAnalyzing(false);
    }
  };


  const handleGenerateScripts = async () => {
    setIsGenerating(true);
    setDownloadUrl(null);
    try {
      const genAI = new GoogleGenerativeAI(geminiKey);
      const completedTracksNames = tracks.filter(t => t.completed).map(t => t.name).join(', ');
      const upcoming = nextTrackIndex !== -1 ? tracks[nextTrackIndex].name : 'Fin de Temporada';
      const context = `Temporada: 2026. Pistas: ${completedTracksNames}. Próxima: ${upcoming}. IA: ${analysis}. FiaScore: ${fiaScoreData.label}. Extra: ${customPrompt}`;

      const model = genAI.getGenerativeModel({ 
        model: 'gemini-2.5-flash-lite',
        systemInstruction: SCRIPT_SYSTEM_INSTRUCTION_DYNAMIC,
        generationConfig: {
          responseMimeType: "application/json",
        }
      });
      const result = await model.generateContent(`Contexto: ${context}`);
      const data = JSON.parse(result.response.text() || '{"scripts": []}');
      if (data.scripts) { setScripts(data.scripts); setActiveScriptIdx(0); }
    } catch (err) { console.error(err); } finally { setIsGenerating(false); }
  };

  const handlePlayTTS = async () => {
    const currentScript = scripts[activeScriptIdx];
    if (!currentScript) return;
    setIsPlayingTTS(true);
    const ctx = initAudio();
    try {
      const ai = new GoogleGenAI({ apiKey: geminiKey });

      // Preparar instrucciones de estilo (persona) para cada voz
      const femaleInstruction = `Habla como una mujer locutora de radio nocturna argentina, especializada en automovilismo. Voz de mujer, tono agudo y sedoso; transmití seguridad, experiencia y pasión por los motores. Ritmo acelerado y cadencioso, sensual pero sobrio; sin exageraciones. Usá modismos argentinos suaves y naturales (ej.: \"che\", \"piola\"), sin caricatura.`;
      const maleInstruction = `Sos un locutor de radio AM argentino, estilo deportivo clásico. Ritmo rápido y dinámico, voz grave y proyectada, con energía constante. Pronunciación clara y precisa, acento rioplatense natural. Entusiasmo genuino por el automovilismo, sin sonar artificial ni robótico. Usá el ritmo acelerado propio de los narradores deportivos argentinos.`;

      const voiceInstruction = selectedVoice === 'Achernar' ? femaleInstruction : maleInstruction;

      // Escapar texto simple para colocar dentro de SSML (mínimo)
      const escapeForSsml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

      // SSML base: ajusta rate/pitch/volume para cada voz y agrega pausas y énfasis
      const ssmlBody = (() => {
        const escaped = escapeForSsml(currentScript);
        if (selectedVoice === 'Achernar') {
          return `<speak><prosody rate=\"97%\" pitch=\"-2st\" volume=\"+1dB\">${escaped.replace(/\n\n/g, '<break time=\"260ms\"/>')}</prosody></speak>`;
        }
        // Voz masculina cínica
        return `<speak><prosody rate="115%" pitch="-1st" volume="+2dB">${escaped.replace(/\n\n/g, '<break time="150ms\"/>')}</prosody></speak>`;
      })();

      // Componer prompt: instrucción de estilo + SSML (el SDK/endpoint de TTS debe respetar SSML en input)
      const prompt = `${voiceInstruction}\n\n${ssmlBody}`;

      // speechConfig: solo enviamos la configuración de voz soportada por la API.
      // Control de rate/pitch/volume lo hacemos mediante SSML (prosody) porque
      // el endpoint rechaza campos desconocidos como speakingRate/pitch/volumeGainDb.
      const speechConfig: any = {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: selectedVoice } }
      };

      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        // Enviamos el SSML combinado en parts.text; el SDK TTS suele aceptar SSML en el texto de entrada
        contents: [{ parts: [{ text: prompt }] }],
        config: {
          responseModalities: ["AUDIO"],
          speechConfig,
        },
      });
      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (base64Audio) {
        const rawPcm = decode(base64Audio);
        const audioBuffer = await decodeAudioData(rawPcm, ctx, 24000, 1);
        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.playbackRate.value = selectedVoice === 'Achernar' ? 1.05 : 1.12;
        source.connect(ctx.destination);
        source.onended = () => setIsPlayingTTS(false);
        source.start(0);
        const wavBlob = createWavBlob(rawPcm, 24000);
        setDownloadUrl(URL.createObjectURL(wavBlob));
      }
    } catch (err) { 
      console.error(err);
      setIsPlayingTTS(false); 
    }
  };

  const handleConfirmEmission = async () => {
    if (!downloadUrl || !scripts[activeScriptIdx]) return;

    try {
      // Convertir blob URL a base64 para persistir en localStorage
      const response = await fetch(downloadUrl);
      const blob = await response.blob();
      const base64 = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.readAsDataURL(blob);
      });

      const newEmission = {
        id: Date.now().toString(),
        script: scripts[activeScriptIdx],
        voice: VOICE_OPTIONS.find(v => v.id === selectedVoice)?.label || selectedVoice,
        audioUrl: base64, // ✅ base64 en lugar de blob URL
        timestamp: new Date()
      };

      const updatedHistory = [newEmission, ...emissionHistory];
      setEmissionHistory(updatedHistory);
      localStorage.setItem('palporro-emissions', JSON.stringify(updatedHistory));
      setDownloadUrl(null);
    } catch (err) {
      console.error('Error guardando emisión:', err);
      alert('Error al guardar la emisión.');
    }
  };

  const handleDeleteEmission = (id: string) => {
    // Only allow deletion if the RADIO section has been unlocked with the correct code
    if (!isRadioUnlocked) {
      alert('Acceso denegado: debes introducir el código para acceder a la sección RADIO para poder borrar emisiones.');
      return;
    }

    const updated = emissionHistory.filter(e => e.id !== id);
    setEmissionHistory(updated);
    localStorage.setItem('palporro-emissions', JSON.stringify(updated));
  };

  // Default emission used only for display when there are no saved emissions
  const defaultEmission = {
    id: 'default-bienvenida',
    script: 'Bienvenida a Palporro Racing — sintonizá y disfrutá.',
    voice: 'Bienvenida',
    audioUrl: '/Promo_Palporro_V2.wav',
    timestamp: new Date()
  };

  const displayedHistory = emissionHistory.length === 0 ? [defaultEmission] : emissionHistory;

  // When a track is clicked from portada, open its results modal and allow editing via radio code
  const handleTrackClick = async (trackName: string) => {
    console.log('handleTrackClick:', trackName, 'raceHistoryCount:', raceHistory?.length);
    // Try to find cached race first (exact match)
    let found = raceHistory.find(r => r.track_name === trackName || r.track_name === `${trackName} GP`);
    // If not found, try a case-insensitive contains match as a fallback (helps for variants)
    if (!found) {
      const lower = trackName.toLowerCase();
      found = raceHistory.find(r => (r.track_name || '').toLowerCase().includes(lower) || (r.track_name || '').toLowerCase() === `${lower} gp`);
    }
    // If not found, fetch latest history from current environment and retry
    if (!found) {
      try {
        const currentEnv = getEnvironment();
        const latest = await getRaceHistory(currentEnv as any);
        if (latest && latest.length) {
          setRaceHistory(prev => {
            // merge latest into prev, preferring latest entries
            const map: Record<string, RaceHistory> = {};
            [...(latest || []), ...(prev || [])].forEach(r => { map[String(r.race_number) || r.id] = r; });
            return Object.values(map).sort((a,b) => b.race_number - a.race_number);
          });
          found = latest.find(r => r.track_name === trackName || r.track_name === `${trackName} GP`);
        }
      } catch (err) {
        console.error('Error fetching history on demand:', err);
      }
    }

    if (found) {
      try {
        // Try to fetch the freshest version from Supabase by id to ensure relevant_data/session_info are present
        // Use the environment attached to the found record if available; fallback to the app environment.
        const env = (found as any).environment || getEnvironment();
        console.log('📋 Abriendo modal para:', found.track_name, {
          id: found.id,
          env,
          hasRelevantData: !!found.relevant_data,
          hasSessionInfo: !!found.session_info,
          hasResults: !!(found.race_results && found.race_results.length > 0)
        });
        
        if (found.id) {
          const fresh = await getRaceById(found.id, env as any);
          console.log('📋 Datos frescos de Supabase:', {
            found: !!fresh,
            hasRelevantData: !!fresh?.relevant_data,
            hasSessionInfo: !!fresh?.session_info,
            relevantData: fresh?.relevant_data,
            sessionInfo: fresh?.session_info
          });
          
          if (fresh) {
            setSelectedHistoryRace(fresh);
            setShowResultsModal(true);
          } else {
            // If fetch by id failed, still show the cached entry
            console.warn('⚠️ No se pudieron cargar datos frescos, usando caché');
            setSelectedHistoryRace(found);
            setShowResultsModal(true);
          }
        } else {
          console.warn('⚠️ Carrera sin ID, usando datos del caché');
          setSelectedHistoryRace(found);
          setShowResultsModal(true);
        }
      } catch (err) {
        console.error('❌ Error fetching full race by id:', err);
        setSelectedHistoryRace(found);
        setShowResultsModal(true);
      }
    } else if (isRadioUnlocked) {
      // Usuario tiene el código: abrir modal vacío para permitir crear/editar resultados manualmente
      const empty: RaceHistory = {
        id: `manual-${Date.now()}`,
        race_number: -1,
        track_name: trackName,
        scheduled_date: new Date().toISOString(),
        scheduled_day: new Date().toLocaleDateString('es-AR', { weekday: 'long' }),
        scheduled_time: new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }),
        confirmed_pilots: [],
        race_completed: false,
        race_results: [],
        created_at: new Date().toISOString()
      };
      setSelectedHistoryRace(empty);
      // Open modal in edit mode with a single empty row so user can add details immediately
      setEditingResults([{ pilot: '', position: 1, totalTime: '', bestLap: '', isWinner: false }]);
      setIsEditingResults(true);
      setShowResultsModal(true);
    } else {
      // No hay resultados aún: en lugar de mostrar un alert, abrimos el mismo modal de resultados
      // pero con un objeto vacío de carrera (sin resultados). El modal renderizará el mensaje
      // "No hay resultados aún" y mostrará el botón "Editar" para que, si el usuario posee
      // el código, pueda desbloquear la edición desde allí.
      const empty: RaceHistory = {
        id: `empty-${Date.now()}`,
        race_number: -1,
        track_name: trackName,
        scheduled_date: new Date().toISOString(),
        scheduled_day: new Date().toLocaleDateString('es-AR', { weekday: 'long' }),
        scheduled_time: new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }),
        confirmed_pilots: [],
        race_completed: false,
        race_results: [],
        created_at: new Date().toISOString()
      };
      // Ensure editing state is reset (read-only view), but modal stays open so user can see
      // the "no results" message and the Edit button to unlock editing if they have the code.
      setSelectedHistoryRace(empty);
      setEditingResults(null);
      setIsEditingResults(false);
      setShowResultsModal(true);
    }
  };

  // Función para parsear el JSON del formato de carrera
  const parseRaceJson = (jsonStr: string): { results: RaceResult[]; sessionInfo: any; relevantData: any } | null => {
    try {
      const data = JSON.parse(jsonStr);

      // Aceptar múltiples nombres de campo que Gemini puede devolver
      const classification =
        data.clasificacion_completa ||
        data.clasificacion ||
        data.results ||
        data.drivers ||
        data.pilotos ||
        data.race_results ||
        data.classification ||
        null;

      if (!classification || !Array.isArray(classification) || classification.length === 0) {
        console.error('parseRaceJson: estructura recibida:', Object.keys(data));
        alert(
          'El JSON no tiene el formato esperado.\n\n' +
          'Campos encontrados: ' + Object.keys(data).join(', ') + '\n\n' +
          'Se esperaba uno de: clasificacion_completa, results, drivers, pilotos.'
        );
        return null;
      }

      // Normalizar campos de cada item para unificar variantes de nombre
      const normalizedRaw = classification.map((item: any) => ({
        // Nombre del piloto: aceptar nombre, name, pilot, driver
        nombre: item.nombre || item.name || item.pilot || item.driver || '',
        // Posición: posicion, position, pos, finishing_position
        posicion: item.posicion ?? item.position ?? item.pos ?? item.finishing_position ?? 0,
        // Tiempos
        tiempo_total: item.tiempo_total || item.total_time || item.time || item.totalTime || '',
        mejor_vuelta: item.mejor_vuelta || item.best_lap || item.fastest_lap || item.bestLap || '',
        // Extras
        vueltas: item.vueltas ?? item.laps ?? item.lap_count ?? undefined,
        incidentes: item.incidentes ?? item.incidents ?? item.penalties ?? 0,
        estado: item.estado || item.status || item.finish_status || '',
        mejores_sectores: item.mejores_sectores || item.best_sectors || item.sectors || undefined,
      }));

      // Normalizar nombres AC → Palporro
      const normalizedItems = normalizeRaceResults(normalizedRaw);

      const results: RaceResult[] = normalizedItems.map((item: any) => ({
        pilot: item.normalizedName,
        position: item.posicion || 0,
        totalTime: item.tiempo_total || '',
        bestLap: item.mejor_vuelta || '',
        isWinner: (item.posicion || 0) === 1,
        isNoShow: (item.estado || '').toLowerCase().includes('no presentó')
               || (item.estado || '').toLowerCase().includes('no show')
               || (item.estado || '').toLowerCase().includes('dns')
               || (item.estado || '').toLowerCase().includes('dnf'),
        laps: item.vueltas,
        incidents: item.incidentes,
        status: item.estado,
        bestSectors: item.mejores_sectores ? {
          S1: item.mejores_sectores.S1 || item.mejores_sectores.s1,
          S2: item.mejores_sectores.S2 || item.mejores_sectores.s2,
          S3: item.mejores_sectores.S3 || item.mejores_sectores.s3,
        } : undefined,
      }));

      const unmapped = getUnmappedPilots(normalizedRaw.map((r: any) => r.nombre));
      if (unmapped.length > 0) {
        console.warn('⚠️ Pilotos sin mapeo AC→Palporro (se usan nombres originales):', unmapped);
      }

      const sessionInfo = data.sesion_info || data.session_info || null;

      // datos_relevantes usa rendimiento + resumen_jornada (según el prompt de Gemini).
      // Normalizar a performance + summary también para que el modal los muestre.
      const rawRelevant = data.datos_relevantes || data.relevant_data || null;
      const relevantData = rawRelevant ? {
        ...rawRelevant,
        performance:    rawRelevant.rendimiento     || rawRelevant.performance || '',
        summary:        rawRelevant.resumen_jornada || rawRelevant.summary     || '',
      } : null;

      return { results, sessionInfo, relevantData };
    } catch (err) {
      console.error('Error parsing JSON:', err);
      alert('Error al parsear el JSON. Verificá que sea un JSON válido.');
      return null;
    }
  };

  // Generate a simple relevant_data object from race results when none is provided
  const computeRelevantDataFromResults = (results: RaceResult[]) => {
    const winner = results.find(r => r.position === 1) || results[0] || null;
    const pilotsCount = results.length;
    const noShows = results.filter(r => r.isNoShow).length;
    const incidents = results.reduce((acc, r) => acc + (r.incidents || 0), 0);

    const rendimiento = `Pilotos: ${pilotsCount} • Incidentes: ${incidents} • No-shows: ${noShows}`;
    const resumen_jornada = winner
      ? `Ganador: ${winner.pilot} (${winner.totalTime || 'tiempo no disponible'})`
      : 'Resultados sin ganador claro';

    // Exponer ambas variantes de nombre para compatibilidad con el modal
    return {
      rendimiento,
      resumen_jornada,
      performance: rendimiento,
      summary: resumen_jornada,
    };
  };

  const handleImportJson = () => {
    const parsed = parseRaceJson(jsonInput);
    if (parsed) {
      setEditingResults(parsed.results);
      setSessionInfo(parsed.sessionInfo);
      setRelevantData(parsed.relevantData);
      setShowJsonImport(false);
      setJsonInput('');
      alert(`Se importaron ${parsed.results.length} resultados correctamente`);
    }
  };

  // Función para actualizar standings después de guardar resultados
  const updateStandingsFromRace = async (results: RaceResult[]) => {
    if (!results || results.length === 0) return;

    console.log('=== ACTUALIZANDO STANDINGS ===');
    console.log('Resultados recibidos:', results);

    const parseLapTime = (t?: string): number | null => {
      if (!t) return null;
      try {
        const trimmed = String(t).trim();
        if (trimmed.includes(':')) {
          const parts = trimmed.split(':').map(p => p.trim());
          const minutes = parseInt(parts[0] || '0', 10) || 0;
          const secs = parseFloat(parts[1] || '0') || 0;
          return Math.round((minutes * 60 + secs) * 1000);
        }
        const secs = parseFloat(trimmed);
        if (isNaN(secs)) return null;
        return Math.round(secs * 1000);
      } catch (e) {
        return null;
      }
    };

    const bestLapEntry = results
      .filter(r => r.bestLap && !r.isNoShow)
      .map(r => ({ pilot: r.pilot, raw: r.bestLap, ms: parseLapTime(r.bestLap) }))
      .filter(x => x.ms !== null)
      .sort((a, b) => (a.ms as number) - (b.ms as number))[0];

    const bestLapTime = bestLapEntry ? bestLapEntry.raw : null;
    const bestLapPilot = bestLapEntry ? bestLapEntry.pilot : null;
    console.log('Mejor vuelta de la carrera:', bestLapTime);

    const totalPositions = results.filter(r => !r.isNoShow).length;

    // Actualizar estado local
    const updatedStandings = await new Promise<Standing[]>((resolve) => {
      setStandings(prev => {
        const updated = [...prev];

        results.forEach(result => {
          let pilotIndex = updated.findIndex(s => s.pilot === result.pilot);
          if (pilotIndex === -1) {
            console.log(`⚠️ Piloto ${result.pilot} no encontrado — lo agrego`);
            updated.push({ pilot: result.pilot, points: 0, racesRun: 0, lastResult: 'N/A', incidences: 0, wins: 0, fastestLaps: 0 });
            pilotIndex = updated.length - 1;
          }

          if (result.isNoShow) {
            console.log(`❌ ${result.pilot} - NO SHOW: -1 punto`);
            updated[pilotIndex] = {
              ...updated[pilotIndex],
              points: Math.max(0, (updated[pilotIndex].points || 0) - 1),
              racesRun: (updated[pilotIndex].racesRun || 0) + 1,
              lastResult: 'DNS',
              incidences: (updated[pilotIndex].incidences || 0) + (result.incidents || 0),
            };
            return;
          }

          let positionPoints: number;
          if (scoringSystem === 2) {
            positionPoints = result.position === 1
              ? Math.floor(totalPositions * 1.5)
              : Math.max(1, totalPositions - (result.position || 0) + 1);
          } else {
            positionPoints = Math.max(1, totalPositions - (result.position || 0) + 1);
          }

          const isFastest = bestLapPilot === result.pilot;
          const prevFL = updated[pilotIndex].fastestLaps || 0;
          const newFL = prevFL + (isFastest ? 1 : 0);
          let fastestLapBonus = 0;
          if (isFastest) {
            if (newFL === 2) fastestLapBonus = 1;
            else if (newFL === 4) fastestLapBonus = 2;
          }

          const racePoints = positionPoints + fastestLapBonus;

          console.log(`✅ ${result.pilot} (P${result.position}) [S${scoringSystem}]:`, {
            totalPositions, positionPoints,
            fastestLaps: `${prevFL}→${newFL}`,
            fastestLapBonus: fastestLapBonus ? `🏁 +${fastestLapBonus}` : '',
            racePoints
          });

          updated[pilotIndex] = {
            ...updated[pilotIndex],
            points: (updated[pilotIndex].points || 0) + racePoints,
            racesRun: (updated[pilotIndex].racesRun || 0) + 1,
            lastResult: `P${result.position}`,
            incidences: (updated[pilotIndex].incidences || 0) + (result.incidents || 0),
            wins: (updated[pilotIndex].wins || 0) + (result.position === 1 ? 1 : 0),
            fastestLaps: newFL
          };
        });

        const sorted = updated.sort((a, b) => b.points - a.points);
        console.log('Standings:', sorted.map(s => ({ pilot: s.pilot, points: s.points, fl: s.fastestLaps })));
        resolve(sorted);
        return sorted;
      });
    }); // ← cierre correcto del await new Promise

    // Guardar en Supabase
    try {
      const env = getEnvironment() as any;
      const standingsToSave = updatedStandings.map(s => ({
        pilot: s.pilot,
        points: s.points,
        races_run: s.racesRun,
        last_result: s.lastResult,
        incidences: s.incidences,
        wins: s.wins || 0,
        fastest_laps: s.fastestLaps || 0
      }));
      console.log('📤 Guardando en Supabase:', standingsToSave);
      const saved = await upsertStandings(standingsToSave, env);
      if (saved) {
        console.log('✅ Standings guardados en Supabase');
      } else {
        console.error('❌ Error guardando standings en Supabase');
      }
    } catch (err) {
      console.error('Error saving standings:', err);
    }
  };

  // Agregar estas funciones antes del return del componente
  const handleVoteSubmit = async () => {
    console.log('handleVoteSubmit triggered', {
      selectedSlots: votingState.selectedSlots,
      userPilot: votingState.userPilot,
      isSubmittingVote
    });
    if (!votingState.selectedSlots || votingState.selectedSlots.length === 0) {
      alert('Debes seleccionar al menos una combinación de día y horario');
      return;
    }

    setIsSubmittingVote(true);
    try {
    const rawPilot = votingState.userPilot!;
    const canonicalPilot = rawPilot;

    const voteData: VoteData = {
      slots: votingState.selectedSlots,
      pilot: canonicalPilot,
      timestamp: Date.now(),
      ip: undefined,
      track_name: (nextTrackIndex !== -1 && tracks[nextTrackIndex])
        ? tracks[nextTrackIndex].name
        : undefined
    };

    // Best-effort: fetch public IP with timeout (no bloquear el submit si falla)
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      const resp = await fetch('https://api.ipify.org?format=json', { signal: controller.signal });
      clearTimeout(timeoutId);
      if (resp.ok) {
        const j = await resp.json();
        voteData.ip = j.ip;
      }
    } catch (e) {
      // ignore: IP es opcional, no bloquear el voto
    }

    // Use the centralized getEnvironment() so all voting operations use
    // the same credentials/runtime config as the Supabase client.
    const environment = getEnvironment();
    console.log('Attempting addVote', { environment, voteData });
    const success = await addVote(voteData, environment);

    if (!success) {
      console.error('addVote returned false — voto NO guardado', { environment, voteData });
      // Save pending vote locally so it can be retried or inspected
      try {
        localStorage.setItem('palporro_pending_vote', JSON.stringify({ voteData, environment, ts: Date.now() }));
      } catch (e) {
        console.warn('Could not save pending vote to localStorage', e);
      }
      // No fallback to /api/vote in PROD: we prefer direct requests to Supabase domain.
      // addVote already attempts the supabase-js client and a REST fallback to the project supabase domain.
      // If we reach this point, the vote will remain saved locally (palporro_pending_vote) for manual or automatic retry.
      alert('Error al guardar el voto en Supabase. El voto quedó guardado localmente y se reintentará cuando el servicio esté disponible.');
      setIsSubmittingVote(false);
      return;
    }

    // Filtrar votos anteriores del mismo piloto y agregar el nuevo
    const updatedVotes = [
      ...votingState.allVotes.filter(v => v.pilot !== canonicalPilot),
      voteData
    ];
    
    const newState = {
      ...votingState,
      hasVoted: true,
      allVotes: updatedVotes
    };

    setVotingState(newState);
    localStorage.setItem('palporro_voting', JSON.stringify(newState));

    // Si no hay pista asignada, asignarla ahora que hay al menos un voto
    // Hacerlo acá (no en subscribeToVotes) para evitar problemas de closure
    // con raceHistory/tracks desactualizados o filtros de cutoff en getRelevantVotes
    const currentPinned = await getPinnedTrack(getEnvironment());
    if (!currentPinned) {
      const currentRaceHistory = await getRaceHistory(getEnvironment() as any);
      const chosenIdx = pickRandomNextTrack(tracks, currentRaceHistory || raceHistory);
      const chosenName = tracks[chosenIdx]?.name;
      if (chosenName) {
        console.log('🎯 [voto] Asignando pista:', chosenName);
        await pinNextTrack(chosenName, getEnvironment());
        setNextTrackIndex(chosenIdx);
      }
    }

    setIsSubmittingVote(false);
    } catch (err) {
      console.error('handleVoteSubmit error inesperado:', err);
      alert('Error inesperado al votar. Por favor intentá de nuevo.');
      setIsSubmittingVote(false);
    }
  };

  // Easter egg: single click on the FiaScore shows a fun toast and attempts to play a short sound
  const [showEggToast, setShowEggToast] = useState(false);

  const handleFiaScoreClick = () => {
    setShowEggToast(true);
    setTimeout(() => setShowEggToast(false), 3000);
    // Try to play an existing short sound in public/ if available
    try {
      const snd = new Audio('/easteregg.mp3');
      snd.volume = 0.45;
      snd.play().catch(() => {});
    } catch (e) {}
  };

  // Render egg toast in JSX via a small portal-like element near root

  const handlePilotSelection = (pilot: string) => {
    // No permitir cambiar de piloto una vez seleccionado para votar (solo modificar voto de ese piloto)
    if (votingState.userPilot && pilot !== votingState.userPilot) {
      // Silenciosamente ignorar intentos de cambio de piloto
      return;
    }
    localStorage.setItem('palporro_user_pilot', pilot);
    setVotingState(prev => ({ ...prev, userPilot: pilot }));
    setShowPilotSelector(false);
  };

  const toggleSlot = (day: string, time: string) => {
    setVotingState(prev => {
      const exists = prev.selectedSlots.some(s => s.day === day && s.time === time);
      return {
        ...prev,
        selectedSlots: exists
          ? prev.selectedSlots.filter(s => !(s.day === day && s.time === time))
          : [...prev.selectedSlots, { day, time }]
      };
    });
  };

  const cartesianSlots = (days: string[], times: string[]) => {
    const out: TimeSlot[] = [];
    days.forEach(d => times.forEach(t => out.push({ day: d, time: t })));
    // unique
    const uniq = out.filter((s, idx, arr) => arr.findIndex(x => x.day === s.day && x.time === s.time) === idx);
    return uniq;
  };

  const toggleDay = (day: string) => {
    setVotingState(prev => {
      const has = prev.selectedDays.includes(day);
      const days = has ? prev.selectedDays.filter(d => d !== day) : [...prev.selectedDays, day];
      const slots = cartesianSlots(days, prev.selectedTimes);
      return { ...prev, selectedDays: days, selectedSlots: slots };
    });
  };

  const toggleTime = (time: string) => {
    setVotingState(prev => {
      const has = prev.selectedTimes.includes(time);
      const times = has ? prev.selectedTimes.filter(t => t !== time) : [...prev.selectedTimes, time];
      const slots = cartesianSlots(prev.selectedDays, times);
      return { ...prev, selectedTimes: times, selectedSlots: slots };
    });
  };

  const isSlotSelected = (day: string, time: string) =>
    votingState.selectedSlots.some(s => s.day === day && s.time === time);

  const getVoteSummary = () => {
    const dayCounts: Record<string, number> = {};
    const timeCounts: Record<string, number> = {};

    votingState.allVotes.forEach(vote => {
      (vote.slots || []).forEach(slot => {
        dayCounts[slot.day] = (dayCounts[slot.day] || 0) + 1;
        timeCounts[slot.time] = (timeCounts[slot.time] || 0) + 1;
      });
    });

    return { dayCounts, timeCounts };
  };

  const getSlotCounts = () => {
    const map: Record<string, { day: string; time: string; count: number; pilots: string[] }> = {};
    votingState.allVotes.forEach(v => {
      (v.slots || []).forEach(s => {
        const key = `${s.day}|${s.time}`;
        if (!map[key]) map[key] = { day: s.day, time: s.time, count: 0, pilots: [] };
        map[key].count += 1;
        if (v.pilot && !map[key].pilots.includes(v.pilot)) map[key].pilots.push(v.pilot);
      });
    });
    return map;
  };

  const getNextRaceInfo = () => {
    if (votingState.allVotes.length === 0) {
      return null;
    }
    // Instead of picking top day and top time independently, compute the (day,time)
    // pair with the most supporting pilots (votes that include both the day and the time).
    const { dayCounts, timeCounts } = getVoteSummary();

    let bestPair: { day: string; time: string; votes: number } | null = null;
    for (const day of VOTING_DAYS) {
      for (const time of VOTING_TIMES) {
        const count = votingState.allVotes.filter(v => (v.slots || []).some(s => s.day === day && s.time === time)).length;
        if (!bestPair || count > bestPair.votes) bestPair = { day, time, votes: count };
      }
    }

    if (!bestPair) return null;

    const dayName = bestPair.day;
    const time = bestPair.time;
    const dayVotes = dayCounts[dayName] || 0;
    const timeVotes = timeCounts[time] || 0;

    // Calcular fecha tentativa (próximo día de la semana)
    const dayMap: Record<string, number> = {
      'Lunes': 1,
      'Martes': 2,
      'Miércoles': 3,
      'Jueves': 4,
      'Viernes': 5
    };

    // Use Argentina timezone when computing the next occurrence so "día siguiente" is relative
    const now = new Date();
    const argNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
    const targetDay = dayMap[dayName];
    const currentDay = argNow.getDay();

    // Compute daysUntil as the nearest future occurrence of targetDay.
    // If targetDay === currentDay we only consider "today" if the target time is still in the future
    let daysUntil = targetDay - currentDay;
    if (daysUntil < 0) daysUntil += 7;

    // If the target day is today (daysUntil === 0) check the time: if the candidate time already passed today,
    // treat it as next week's occurrence (daysUntil = 7). This ensures we pick the next future date for that day/time.
    if (daysUntil === 0) {
      // parse time like '20:00'
      const [hh, mm] = (time || '').split(':').map((v: string) => parseInt(v, 10) || 0);
      const candidate = new Date(argNow);
      candidate.setHours(hh, mm, 0, 0);
      if (candidate.getTime() <= argNow.getTime()) {
        daysUntil = 7; // next week's occurrence
      } else {
        daysUntil = 0; // later today -> keep today
      }
    }

    const raceDate = new Date(argNow);
    raceDate.setDate(argNow.getDate() + daysUntil);
    // ensure raceDate has the proper hour/minute of the chosen time
    const [raceH, raceM] = (time || '').split(':').map((v: string) => parseInt(v, 10) || 0);
    raceDate.setHours(raceH, raceM, 0, 0);

    // Verificar si es definitivo:
    // - Si al menos 4 pilotos votaron la misma combinación (día+hora) => definitivo inmediatamente.
    // - O si la fecha es para el día siguiente o el mismo día (daysUntil <= 1) y al menos 3 pilotos votaron => definitivo.
    const votesForDate = votingState.allVotes.filter(v => (v.slots || []).some(s => s.day === dayName && s.time === time)).length;
    const isDefinitive = (votesForDate >= 4) || (daysUntil <= 1 && votesForDate >= 3);

    // Desacuerdo: hay 2+ votos pero ninguna combinación día+hora tiene al menos 2
    const hasDisagreement = votingState.allVotes.length >= 2 && votesForDate < 2;
    // Con 1 solo voto se muestra tentativa normalmente

    return {
      day: dayName,
      time,
      date: raceDate,
      isDefinitive,
      hasDisagreement,
      dayVotes,
      timeVotes,
      votesForDate,
      totalVotes: votingState.allVotes.length
    };
  };


  const getPilotConfirmation = (pilotName: string) => {
  const vote = votingState.allVotes.find(v => v.pilot === pilotName);
  if (!vote) return { confirmed: false, availability: null };

  const nextRace = getNextRaceInfo();
  if (!nextRace) return { confirmed: false, availability: null };

  const hasDay = (vote.slots || []).some(s => s.day === nextRace.day);
  const hasTime = (vote.slots || []).some(s => s.time === nextRace.time && s.day === nextRace.day);

  return {
    confirmed: hasDay && hasTime,
    availability: hasDay ? (hasTime ? 'confirmed' : 'partial') : 'unavailable'
  };
};
  const notifyRaceConfirmed = async (data: {
    trackName: string;
    date: Date;
    day: string;
    time: string;
    pilots: string[];
    raceNumber: number;
  }) => {
    const webhookUrl = import.meta.env.VITE_N8N_WEBHOOK_URL
      || (window as any).__PALPORRO_CONFIG?.VITE_N8N_WEBHOOK_URL
      || '';
    if (!webhookUrl) {
      console.warn('⚠️ VITE_N8N_WEBHOOK_URL no configurada');
      return;
    }
    try {
      console.log('📡 Llamando webhook n8n...', webhookUrl);
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          evento: 'carrera_confirmada',
          carrera: data.raceNumber,
          pista: data.trackName,
          fecha: data.date.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' }),
          dia: data.day,
          hora: data.time,
          pilotos: data.pilots,
          pilotos_count: data.pilots.length
        })
      });
      console.log('✅ Webhook n8n notificado');
    } catch (err) {
      console.warn('⚠️ No se pudo notificar webhook n8n:', err);
    }
  };
  // Función para guardar la carrera actual en el historial y resetear votación
  const archiveCurrentRaceAndReset = async () => {
    const nextRace = getNextRaceInfo();
    if (!nextRace || nextRace.totalVotes === 0) {
      console.log('No hay carrera para archivar');
      return;
    }
    const trackIndex = nextTrackIndex;
    // If no next track index is available, proceed with a fallback name and still reset voting.
    const trackName = (trackIndex !== -1 && tracks[trackIndex]) ? tracks[trackIndex].name : (tracks[0]?.name || 'Sin pista');
    const confirmedPilots = votingState.allVotes
      .filter(v => (v.slots || []).some(s => s.day === nextRace.day && s.time === nextRace.time))
      .map(v => v.pilot);

    console.log('Archivando carrera:', {
      trackName,
      date: nextRace.date,
      confirmedPilots
    });

    const raceNumber = completedCount + 1;
    const environment = getEnvironment();
    
    let success = false;
    try {
      success = await saveRaceHistory(
      raceNumber,
      trackName,
      nextRace.date,
      nextRace.day,
      nextRace.time,
      confirmedPilots,
      environment
    );
    } catch (err) {
      console.error('saveRaceHistory threw error:', err);
      success = false;
    }
    if (!success) {
      console.error('Error al archivar carrera en Supabase — continuaré con el reseteo local de votación para evitar bloqueo semanal');
    } else {
      console.log('Carrera archivada exitosamente en Supabase');
      await notifyRaceConfirmed({
        trackName,
        date: nextRace.date,
        day: nextRace.day,
        time: nextRace.time,
        pilots: confirmedPilots,
        raceNumber
      });
    }

    // Intentar mover votos actuales a la tabla histórica (race_votes) y eliminar
    // los votos activos para resetear la votación. Esto preserva historial.
      try {
        // Prefer backend-determined "relevant" votes (getRelevantVotes) to
        // avoid relying on possibly stale local state (votingState.allVotes).
        let votesToArchive = votingState.allVotes || [];
        try {
          const relevant = await getRelevantVotes(environment as any);
          if (Array.isArray(relevant) && relevant.length > 0) {
            votesToArchive = relevant;
          }
        } catch (e) {
          // If dynamic import / fetch fails, fall back to local votes but warn.
          console.warn('Could not fetch relevant votes from supabaseClient, falling back to local votingState.allVotes', e);
        }

        console.log('archive debug: votesToArchive length', votesToArchive.length, { environment });
        console.log('archive debug: local votingState.allVotes length', (votingState.allVotes || []).length);
        if (votesToArchive.length > 0) {
          console.log('Moviendo votos actuales a race_votes y limpiando palporro_votes...');
          const moved = await archiveRaceAndMoveVotes(raceNumber, trackName, nextRace.date, nextRace.day, nextRace.time, confirmedPilots, votesToArchive, environment as any);
          if (moved) console.log('Votos archivados y removidos de la tabla activa.');
          else console.warn('archiveRaceAndMoveVotes devolvió false.');
          await pinNextTrack(null, environment); // resetea para la siguiente votación
          setNextTrackIndex(-1);
        }
      } catch (e) {
        console.error('Error moviendo votos a historial:', e);
      }

    // Siempre resetear el estado de votación local aunque el guardado remoto falle,
    // para garantizar que la semana se cierre y no quede bloqueada.
    const newState = {
      isOpen: false,
      hasVoted: false,
      selectedSlots: [],
      selectedDays: [],
      selectedTimes: [],
      userPilot: votingState.userPilot, // Mantener piloto seleccionado
      allVotes: []
    };
    setVotingState(newState);

    try {
      localStorage.removeItem('palporro_voting');
      // Resetear fecha de inicio de votación al domingo actual
      const now = new Date();
      const argNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
      const d = new Date(argNow);
      const dow = d.getDay();
      d.setDate(d.getDate() - dow);
      d.setHours(0,0,0,0);
      localStorage.setItem('palporro_voting_start', d.toISOString());
      console.log('Votación reseteada correctamente (local)');
      // Mark last archive so periodic check won't run again immediately
      localStorage.setItem('palporro_last_archive', new Date().toISOString());
    } catch (e) {
      console.error('Error resetting voting:', e);
    }
  };
    
  // Detectar cuando la fecha se confirma (isDefinitive cambia a true) y notificar webhook
const wasDefinitiveRef = useRef(false);
  useEffect(() => {
    const nextRace = getNextRaceInfo();
    if (!nextRace) {
      wasDefinitiveRef.current = false;
      return;
    }
    if (nextRace.isDefinitive && !wasDefinitiveRef.current) {
      // Acaba de confirmarse la fecha → llamar webhook
      wasDefinitiveRef.current = true;
      const trackName = (nextTrackIndex !== -1 && tracks[nextTrackIndex])
        ? tracks[nextTrackIndex].name
        : tracks[0]?.name || 'Sin pista';
      const confirmedPilots = votingState.allVotes
        .filter(v => (v.slots || []).some(s => s.day === nextRace.day && s.time === nextRace.time))
        .map(v => v.pilot);
      notifyRaceConfirmed({
        trackName,
        date: nextRace.date,
        day: nextRace.day,
        time: nextRace.time,
        pilots: confirmedPilots,
        raceNumber: completedCount + 1
      });
    } else if (!nextRace.isDefinitive) {
      // Resetear para la próxima vez
      wasDefinitiveRef.current = false;
    }
  }, [votingState.allVotes]);


  // Archivar carrera y resetear votación cuando:
  // 1. La fecha confirmada ya pasó, O
  // 2. Es sábado después de las 18:00 (cierre de semana de votación)
  useEffect(() => {
    const checkArchiveAndReset = async () => {
      const now = new Date();
      const argNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
      
      const next = getNextRaceInfo();
      
      // Condición 1: La carrera confirmada ya pasó
      if (next && next.isDefinitive && next.date.getTime() <= argNow.getTime()) {
        console.log('Carrera confirmada ya pasó, archivando...');
        const lastArchive = localStorage.getItem('palporro_last_archive');
        const lastArchiveDate = lastArchive ? new Date(lastArchive) : null;
        
        // Evitar archivar múltiples veces la misma carrera
        if (!lastArchiveDate || argNow.getTime() - lastArchiveDate.getTime() > 12 * 60 * 60 * 1000) {
          await archiveCurrentRaceAndReset();
          localStorage.setItem('palporro_last_archive', argNow.toISOString());
        }
        return;
      }
      
      // Condición 2: Es sábado después de las 18:00 (fin de semana de votación)
      const day = argNow.getDay(); // 6 = Sábado
      const hours = argNow.getHours();
      
      if (day === 6 && hours >= 18 && next && next.totalVotes > 0) {
        console.log('Es sábado 18:00+, fin de semana de votación');
        const lastArchive = localStorage.getItem('palporro_last_archive');
        const lastArchiveDate = lastArchive ? new Date(lastArchive) : null;
        
        // Solo archivar una vez por semana
        if (!lastArchiveDate || argNow.getTime() - lastArchiveDate.getTime() > 6 * 24 * 60 * 60 * 1000) {
          console.log('Archivando carrera por cierre de semana...');
          await archiveCurrentRaceAndReset();
          localStorage.setItem('palporro_last_archive', argNow.toISOString());
        }
      }
    };

    checkArchiveAndReset();
    // Verificar cada 30 segundos
    const id = setInterval(checkArchiveAndReset, 30 * 1000);
    return () => clearInterval(id);
  }, [votingState.allVotes, completedCount, nextTrackIndex]);

  // Cargar votos al inicio e identificar piloto por IP
  useEffect(() => {
    const environment = getEnvironment();

    const loadVotes = async () => {
      // 1. Obtener IP con timeout corto (NO bloquear la carga de votos)
      const getIpWithTimeout = async (): Promise<string | undefined> => {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 3000);
          const resp = await fetch('https://api.ipify.org?format=json', { signal: controller.signal });
          clearTimeout(timeoutId);
          if (resp.ok) {
            const j = await resp.json();
            return j.ip as string;
          }
        } catch (e) {
          console.warn('No se pudo obtener IP (timeout o error)');
        }
        return undefined;
      };

      // 2. Cargar votos e IP en PARALELO — la IP nunca bloquea los votos
      const [votes, userIp] = await Promise.all([
        (async () => {
          try {
            return await getRelevantVotes(environment);
          } catch (e) {
            return await getVotes(environment);
          }
        })(),
        getIpWithTimeout()
      ]);

      // 3. Si tenemos IP, buscar si ya votó desde esta IP
      if (userIp) {
        const existingVote = votes.find(v => v.ip === userIp);
        if (existingVote) {
          // ✅ Verificar que el piloto siga siendo válido en PILOTS
          const pilotIsValid = PILOTS.includes(existingVote.pilot);
          const storedPilot = localStorage.getItem('palporro_user_pilot');
          const resolvedPilot: string | null = pilotIsValid
            ? existingVote.pilot
            : (storedPilot && PILOTS.includes(storedPilot) ? storedPilot : null);
          
          if (resolvedPilot && resolvedPilot !== existingVote.pilot) {
            // Nombre viejo en BD → actualizar en Supabase con el nombre correcto
            await addVote({ ...existingVote, pilot: resolvedPilot }, environment);
          }
          console.log('Voto existente encontrado por IP:', existingVote.pilot);
          localStorage.setItem('palporro_user_pilot', existingVote.pilot);
          const uniqDays = Array.from(new Set((existingVote.slots || []).map(s => s.day)));
          const uniqTimes = Array.from(new Set((existingVote.slots || []).map(s => s.time)));
          setVotingState(prev => ({
            ...prev,
            allVotes: votes,
            hasVoted: true,
            userPilot: existingVote.pilot,
            selectedSlots: existingVote.slots || [],
            selectedDays: uniqDays,
            selectedTimes: uniqTimes
          }));
          setShowPilotSelector(false);
          // compute stats locally from votes
          const dayCount: Record<string, number> = {};
          const timeCount: Record<string, number> = {};
          votes.forEach(v => (v.slots || []).forEach(s => { dayCount[s.day] = (dayCount[s.day] || 0) + 1; timeCount[s.time] = (timeCount[s.time] || 0) + 1; }));
          setVotingStats({ totalVotes: votes.length, dayCount, timeCount });

          // Si hay votos pero no hay pista fijada, asignar una
          if (votes.length > 0) {
            const currentPinned = await getPinnedTrack(environment);
            if (!currentPinned) {
              const chosenIdx = pickRandomNextTrack(tracks, raceHistory);
              const chosenName = tracks[chosenIdx]?.name;
              if (chosenName) {
                console.log('🎯 Asignando pista (path IP) sin pista fijada:', chosenName);
                await pinNextTrack(chosenName, environment);
                setNextTrackIndex(chosenIdx);
              }
            }
          }
          return;
        }
      }

      // 4. Sin voto previo por IP, cargar votos normalmente
      setVotingState(prev => ({ ...prev, allVotes: votes }));
      // compute stats locally
      const dayCount: Record<string, number> = {};
      const timeCount: Record<string, number> = {};
      votes.forEach(v => (v.slots || []).forEach(s => { dayCount[s.day] = (dayCount[s.day] || 0) + 1; timeCount[s.time] = (timeCount[s.time] || 0) + 1; }));
      setVotingStats({ totalVotes: votes.length, dayCount, timeCount });

      // Si hay votos pero no hay pista fijada, asignar una ahora.
      // Esto cubre el caso en que los votos se resetearon pero nadie volvió a
      // abrir la app en tiempo real para recibir la notificación del primer voto.
      if (votes.length > 0) {
        const currentPinned = await getPinnedTrack(environment);
        if (!currentPinned) {
          const chosenIdx = pickRandomNextTrack(tracks, raceHistory);
          const chosenName = tracks[chosenIdx]?.name;
          if (chosenName) {
            console.log('🎯 Asignando pista por votos existentes sin pista fijada:', chosenName);
            await pinNextTrack(chosenName, environment);
            setNextTrackIndex(chosenIdx);
          }
        }
      }
    };

    loadVotes();

    // Suscribirse a cambios en tiempo real
    const unsubscribe = subscribeToVotes(environment, async (votes) => {
      // Actualizar votos primero
      setVotingState(prev => ({ ...prev, allVotes: votes }));
      const dayCount: Record<string, number> = {};
      const timeCount: Record<string, number> = {};
      votes.forEach((v: any) => (v.slots || []).forEach((s: any) => { dayCount[s.day] = (dayCount[s.day] || 0) + 1; timeCount[s.time] = (timeCount[s.time] || 0) + 1; }));
      setVotingStats({ totalVotes: votes.length, dayCount, timeCount });

      // Si hay votos y no hay pista fijada → asignar nueva pista
      // (cubre tanto el primer voto tras reset como recargas sin pista)
      if (votes.length > 0) {
        const currentPinned = await getPinnedTrack(environment);
        if (!currentPinned) {
          const chosenIdx = pickRandomNextTrack(tracks, raceHistory);
          const chosenName = tracks[chosenIdx]?.name;
          if (chosenName) {
            console.log('🎯 [realtime] Asignando pista:', chosenName);
            await pinNextTrack(chosenName, environment);
            setNextTrackIndex(chosenIdx);
          }
        }
      }
    });

    return () => unsubscribe();
  }, []);

    // When dev cutoff toggles change, re-fetch relevant votes so the UI updates
    useEffect(() => {
      const reloadRelevantVotes = async () => {
        try {
          const environment = getEnvironment();
          const votes = await getRelevantVotes(environment);
          // compute stats locally
          const dayCount: Record<string, number> = {};
          const timeCount: Record<string, number> = {};
          votes.forEach((v: any) => (v.slots || []).forEach((s: any) => { dayCount[s.day] = (dayCount[s.day] || 0) + 1; timeCount[s.time] = (timeCount[s.time] || 0) + 1; }));
          setVotingState(prev => ({ ...prev, allVotes: votes }));
          setVotingStats({ totalVotes: votes.length, dayCount, timeCount });
        } catch (err) {
          console.warn('Failed reloading relevant votes after dev cutoff change', err);
        }
      };

      // Only trigger when developer override changes
      reloadRelevantVotes();
    }, [devSimulateCutoff, devCutoffIso]);

    // Reintentar votos pendientes guardados localmente (palporro_pending_vote)
  useEffect(() => {
    let mounted = true;

    const tryPending = async () => {
      try {
        const raw = localStorage.getItem('palporro_pending_vote');
        if (!raw) return;
        const pending = JSON.parse(raw);
        console.log('Attempting resend of pending vote', pending);
        const success = await addVote(pending.voteData, pending.environment);
        if (success && mounted) {
          console.log('Resend succeeded — removing pending vote');
          localStorage.removeItem('palporro_pending_vote');
          // Update local voting state to reflect the saved vote
          setVotingState(prev => {
            const updatedVotes = [
              ...prev.allVotes.filter(v => v.pilot !== pending.voteData.pilot),
              pending.voteData
            ];
            const newState = { ...prev, hasVoted: true, allVotes: updatedVotes };
            try { localStorage.setItem('palporro_voting', JSON.stringify(newState)); } catch (e) { /* ignore */ }
            return newState;
          });
        }
      } catch (err) {
        console.warn('Retry pending vote failed, will retry later', err);
      }
    };

    // Try immediately, then every 30s
    tryPending();
    const id = setInterval(tryPending, 30_000);
    return () => { mounted = false; clearInterval(id); };
  }, []);

  // Cargar historial de carreras al montar - respetar environment actual
  // When raceHistory changes, rebuild tracks order respecting the pinned track from Supabase
  useEffect(() => {
    const loadApp = async () => {
      try {
        const env = getEnvironment() as 'PROD' | 'TEST' | 'DEV';

        // Cargar historial y pista fijada en paralelo
        const [fetched, pinned] = await Promise.all([
          getRaceHistory(env),
          getPinnedTrack(env)
        ]);

        const sorted = (fetched || []).sort((a, b) => (b.race_number || 0) - (a.race_number || 0));
        setRaceHistory(sorted);

        // Setear pista fijada directamente, antes de que el useEffect de raceHistory se ejecute
        if (pinned) {
          const idx = INITIAL_TRACKS.findIndex(t => t === pinned);
          if (idx !== -1) setNextTrackIndex(idx);
        } else {
          setNextTrackIndex(-1);
        }
      } catch (err) {
        console.error('❌ Error cargando app:', err);
      } finally {
        setIsAppReady(true);
      }
    };
    loadApp();
  }, []);

  useEffect(() => {
    const loadPinnedTrack = async () => {
      const environment = getEnvironment();
      const pinned = await getPinnedTrack(environment);
      if (pinned) {
        const idx = tracks.findIndex(t => t.name === pinned);
        if (idx !== -1) setNextTrackIndex(idx);
      } else {
        setNextTrackIndex(-1); // sin pista → "Pendiente de votación"
      }
    };
    loadPinnedTrack();
  }, []);

  useEffect(() => {
    const environment = getEnvironment();
    const unsub = subscribeToNextTrack(environment, (trackName) => {
      if (trackName) {
        const idx = tracks.findIndex(t => t.name === trackName);
        if (idx !== -1) setNextTrackIndex(idx);
      } else {
        setNextTrackIndex(-1);
      }
    });
    return unsub;
  }, [tracks]);

  // Contador de visitas - incrementar al cargar la página
  useEffect(() => {
    const trackVisit = async () => {
    try {
      const env = getEnvironment() as 'PROD' | 'TEST';

      // 1. Obtener IP pública del visitante
      let userIp: string | undefined;
      try {
        const resp = await fetch('https://api.ipify.org?format=json');
        if (resp.ok) {
          const j = await resp.json();
          userIp = j.ip;
        }
      } catch (e) {
        console.warn('No se pudo obtener IP para contador de visitas');
      }

      // 2. Registrar visita (solo incrementa si es IP nueva o nuevo día)
      const result = await incrementVisits(env, userIp);

      if (result.total > 0) {
        setVisitCount(result.total);
        console.log('👁️ Visitas:', result.total, result.counted ? '(nueva visita contabilizada)' : '(visita repetida hoy)');
      } else {
        // Fallback: leer el total directamente si RPC devolvió 0 inesperadamente
        const count = await getVisitCount(env);
        setVisitCount(count || null);
      }
    } catch (err) {
      console.error('❌ Error con contador de visitas:', err);
      // No mostrar valor hardcodeado en producción, dejar null (oculta el contador)
      setVisitCount(null);
    }
  };

  trackVisit();
}, []);

  // When raceHistory changes, mark completed tracks and pick next track
  // IMPORTANTE: Solo recalcular si se agregó una pista nueva (no al recargar resultados)
  useEffect(() => {
    const calculate = async () => {
      try {
        const completedSet = new Set<string>();
        const completedOrder: string[] = [];
        const ordered = [...raceHistory].sort((a,b) => (a.race_number || 0) - (b.race_number || 0));
        ordered.forEach(r => {
          const name = (r.track_name || '').toLowerCase();
          if (!name) return;
          if (!completedSet.has(name) && (r.race_completed || (r.race_results && r.race_results.length > 0))) {
            completedSet.add(name);
            completedOrder.push(name);
          }
        });

        const completedTracks: TrackStatus[] = [];
        const remainingTracks: TrackStatus[] = [];
        tracks.forEach(t => {
          const key = (t.name || '').toLowerCase();
          if (!completedSet.has(key)) remainingTracks.push({ ...t, completed: false });
        });
        completedOrder.forEach(nameLower => {
          const found = tracks.find(t => (t.name || '').toLowerCase() === nameLower);
          if (found) completedTracks.push({ ...found, completed: true });
        });
        tracks.forEach(t => {
          const key = (t.name || '').toLowerCase();
          if (completedSet.has(key) && !completedTracks.find(ct => (ct.name || '').toLowerCase() === key)) {
            completedTracks.push({ ...t, completed: true });
          }
        });

        // ✅ FUENTE DE VERDAD: pista fijada en Supabase
        let nextName: string | null = null;
        if (remainingTracks.length > 0) {
          const pinned = await getPinnedTrack(getEnvironment());
          if (pinned && remainingTracks.find(t => t.name === pinned)) {
            nextName = pinned;
          }
          // Sin pista fijada → null → muestra "Pendiente de votación"
        }

        const finalTracks: TrackStatus[] = [];
        completedTracks.forEach(t => finalTracks.push(t));
        if (nextName) {
          const nextEntry = remainingTracks.find(t => (t.name || '').toLowerCase() === nextName!.toLowerCase());
          if (nextEntry) finalTracks.push({ ...nextEntry, completed: false });
        }
        remainingTracks.forEach(t => {
          if (!nextName || (t.name || '').toLowerCase() !== nextName.toLowerCase()) {
            finalTracks.push({ ...t, completed: false });
          }
        });

        setTracks(finalTracks);
        const newNextTrackIndex = nextName ? completedTracks.length : -1;
        setNextTrackIndex(newNextTrackIndex);

        console.log('🏁 PRÓXIMA PISTA CALCULADA:', {
          proximaPista: nextName || 'Pendiente de votación',
          indice: newNextTrackIndex,
          pistasCompletadas: completedTracks.map(t => t.name),
        });
      } catch (e) {
        console.error('Error calculando próxima pista:', e);
      }
    };
    calculate();
  }, [raceHistory]);

  // Cargar standings desde Supabase al montar
  useEffect(() => {
    const loadStandings = async () => {
      try {
        const env = getEnvironment() as any;
        const savedStandings = await getStandings(env);
        
        if (savedStandings && savedStandings.length > 0) {
          // Convertir de StandingRecord a Standing
          const standings = savedStandings.map(s => ({
            pilot: s.pilot,
            points: s.points,
            racesRun: s.races_run,
            lastResult: s.last_result,
            incidences: s.incidences,
            fastestLaps: s.fastest_laps || 0
          }));
          setStandings(standings);
          console.log('Standings loaded from Supabase:', standings);
        } else {
          console.log('No standings found in Supabase, using initial state');
        }
      } catch (err) {
        console.error('Error loading standings:', err);
      }
    };

    loadStandings();
  }, []);

  // Agregar función para detectar si hubo cambios
  const hasVoteChanged = (): boolean => {
    const currentVote = votingState.allVotes.find(v => v.pilot === votingState.userPilot);
    if (!currentVote) return false;
    const currentDays = Array.from(new Set((currentVote.slots || []).map(s => s.day)));
    const currentTimes = Array.from(new Set((currentVote.slots || []).map(s => s.time)));

    const daysChanged = JSON.stringify([...votingState.selectedDays].sort()) !== 
                        JSON.stringify([...currentDays].sort());
    const timesChanged = JSON.stringify([...votingState.selectedTimes].sort()) !== 
                         JSON.stringify([...currentTimes].sort());
    
    return daysChanged || timesChanged;
  };

  // ELIMINAR ESTOS DOS useEffect DUPLICADOS:
  // useEffect(() => {
  //   if (!isVotingActive()) return;
  //   
  //   const loadVotingStats = async () => {
  //     const { getVotingStats } = await import('./src/supabaseClient');
  //     const stats = await getVotingStats('PROD');
  //     setVotingStats(stats);
  //   };
  //   
  //   loadVotingStats();
  // }, [votingState.allVotes]);

  // useEffect(() => {
  //   if (!isVotingActive()) return;
  //   
  //   const setupRealtimeSync = async () => {
  //     const { subscribeToVotes, getVotes } = await import('./src/supabaseClient');
  //     
  //     const unsubscribe = subscribeToVotes('PROD', async (votes) => {
  //       setVotingState(prev => ({ ...prev, allVotes: votes }));
  //     });
  //     
  //     const initialVotes = await getVotes('PROD');
  //     setVotingState(prev => ({ ...prev, allVotes: initialVotes }));
  //     
  //     return unsubscribe;
  //   };
  //   
  //   const cleanup = setupRealtimeSync();
  //   return () => { cleanup.then(fn => fn()); };
  // }, []);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans selection:bg-red-600 overflow-x-hidden" style={{ cursor: "url('/GTR34.webp'), auto" }}>
      <div className="fixed inset-0 pointer-events-none opacity-[0.03] bg-[url('https://www.transparenttextures.com/patterns/carbon-fibre.png')]"></div>
      {/* INTRO - gate de click + video con audio + voz de fondo posterior */}
      {introState !== 'done' && (
        <div className="fixed inset-0 z-[200] bg-black flex items-center justify-center">

          {introState === 'gate' && (
            <button
              onClick={() => setIntroState('playing')}
              className="flex flex-col items-center gap-6 group"
            >
              <div className="w-24 h-24 rounded-full border-2 border-red-600 flex items-center justify-center shadow-[0_0_60px_rgba(220,38,38,0.5)] group-hover:shadow-[0_0_80px_rgba(220,38,38,0.8)] transition-all duration-300">
                <svg className="w-10 h-10 text-red-600 ml-1" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M3 22v-20l18 10-18 10z" />
                </svg>
              </div>
              <span className="text-zinc-500 text-xs font-black uppercase tracking-[0.4em]">
                Tocar para iniciar
              </span>

              {/* Checkbox "no volver a mostrar" en la pantalla de gate */}
              <label
                className="flex items-center gap-2 mt-2 cursor-pointer"
                onClick={e => e.stopPropagation()}
              >
                <input
                  type="checkbox"
                  checked={introSkipForever}
                  onChange={e => {
                    const val = e.target.checked;
                    setIntroSkipForever(val);
                    try { 
                      val 
                        ? localStorage.setItem('palporro_intro_skip', '1') 
                        : localStorage.removeItem('palporro_intro_skip');
                    } catch(err) {}
                  }}
                  className="w-4 h-4 accent-red-600"
                />
                <span className="text-zinc-600 text-[10px] font-bold uppercase tracking-widest">
                  No volver a mostrar
                </span>
              </label>
            </button>
          )}

          {introState === 'playing' && (
            <>
              <video
                autoPlay
                playsInline
                onEnded={() => {
                  try { sessionStorage.setItem('palporro_intro_seen', '1'); } catch(e) {}
                  setIntroState('done');
                  // Iniciar voz de fondo al cerrar el video
                  if (bgAudioRef.current) {
                    bgAudioRef.current.volume = 0.5;
                    bgAudioRef.current.play().catch(() => {});
                  }
                }}
                className="w-full h-full object-cover"
              >
                <source src="/intro.mp4" type="video/mp4" />
              </video>

              <button
                onClick={() => {
                  try { sessionStorage.setItem('palporro_intro_seen', '1'); } catch(e) {}
                  setIntroState('done');
                  // Iniciar voz de fondo también al saltar
                  if (bgAudioRef.current) {
                    bgAudioRef.current.volume = 0.5;
                    bgAudioRef.current.play().catch(() => {});
                  }
                }}
                className="absolute bottom-8 right-8 px-4 py-2 bg-zinc-900/80 border border-zinc-700 text-zinc-400 text-xs font-black uppercase tracking-widest rounded-xl hover:bg-zinc-800 transition-all"
              >
                Saltar →
              </button>
            </>
          )}
        </div>
      )}
      {/* PANTALLA DE CARGA */}
    {!isAppReady && introState === 'done' && (
      <div className="fixed inset-0 z-[190] bg-zinc-950 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-10 h-10 border-2 border-red-600 border-t-transparent rounded-full animate-spin" />
          <span className="text-zinc-600 text-[10px] font-black uppercase tracking-[0.4em]">
            Cargando
          </span>
        </div>
      </div>
    )}
      {/* Audio de fondo - se activa después del video */}
      <audio ref={bgAudioRef} src="/intro-bg.mp3" preload="auto" />
      <header className="w-full bg-zinc-900 border-b border-zinc-800 p-2 sticky top-0 z-50 shadow-2xl backdrop-blur-xl bg-opacity-95">
        <div className="max-w-[1600px] mx-auto flex justify-between items-center px-2 md:px-4">
          <div className="flex items-center gap-2 md:gap-6">
            <div className="flex items-center gap-2 md:gap-4">
              <div className="relative w-12 h-12 md:w-14 md:h-14 lg:w-20 lg:h-20 flex items-center justify-center p-2">
                <img src="/Logo.jpg" alt="Logo" className="w-full h-full object-contain drop-shadow-[0_0_15px_rgba(220,38,38,0.4)] scale-110" />
              </div>
              <div className="flex flex-col">
                <div className="bg-red-600 text-white font-black px-2 md:px-4 py-0.5 skew-x-[-12deg] text-[10px] md:text-[12px] lg:text-[14px] uppercase tracking-tighter leading-none mb-1 shadow-[4px_4px_0_rgba(0,0,0,0.3)]">
                  PALPORRO RACING
                </div>
                <div className="flex items-center gap-1 md:gap-2">
                  <span className="w-1 h-1 md:w-1.5 md:h-1.5 rounded-full bg-red-600 animate-pulse"></span>
                  <span className="text-[8px] md:text-[10px] font-black uppercase tracking-[0.2em] md:tracking-[0.4em] text-zinc-500 italic">
                    Liga Febrero 2026
                  </span>
                </div>
              </div>
            </div>
          </div>
          <nav className="flex gap-0.5 md:gap-1 bg-zinc-950 p-0.5 md:p-1 rounded-lg md:rounded-xl border border-zinc-800 shadow-inner">
            <button onClick={() => setActiveTab('dashboard')} className={`px-2 md:px-4 lg:px-6 py-1.5 md:py-2.5 text-[8px] md:text-[10px] font-black uppercase transition-all rounded-lg ${activeTab === 'dashboard' ? 'bg-zinc-100 text-zinc-950 shadow-xl' : 'text-zinc-500'}`}>PORTADA</button>
            <button onClick={() => setActiveTab('radio')} className={`px-2 md:px-4 lg:px-6 py-1.5 md:py-2.5 text-[8px] md:text-[10px] font-black uppercase transition-all rounded-lg ${activeTab === 'radio' ? 'bg-zinc-100 text-zinc-950 shadow-xl' : 'text-zinc-500'}`}>RADIO</button>
            <button onClick={() => setShowHistoryModal(true)} className={`flex items-center gap-1 md:gap-2 px-2 md:px-4 lg:px-6 py-1.5 md:py-2.5 text-[8px] md:text-[10px] font-black uppercase transition-all rounded-lg ${activeTab === 'history' ? 'bg-zinc-100 text-zinc-950 shadow-xl' : 'text-zinc-500'}`}>
              <svg className="w-3 h-3 md:w-4 md:h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" /></svg>
              ARCHIVO ({displayedHistory.length})
            </button>
            <div className="w-px bg-zinc-800 mx-0.5 md:mx-1 self-stretch" />
            <a href="/Reglamento.pdf" target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 md:gap-1.5 px-2 md:px-4 lg:px-5 py-1.5 md:py-2.5 text-[8px] md:text-[10px] font-black uppercase transition-all rounded-lg text-zinc-500 hover:text-white hover:bg-red-600/20 group">
              <svg className="w-3 h-3 md:w-3.5 md:h-3.5 text-red-600 group-hover:text-red-500 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
              REGLAMENTO
            </a>
          </nav>
        </div>
      </header>

      {/* REPRODUCTOR FLOTANTE - visible en Portada; muestra audio por defecto si no hay emisiones */}
      {activeTab === 'dashboard' && (
        <div 
          className="fixed z-50 animate-in slide-in-from-bottom-4 duration-500 hidden md:block"
          style={{
            left: `${floatingPlayerPos.x}px`,
            top: `${floatingPlayerPos.y}px`,
            cursor: isDragging ? 'grabbing' : 'grab'
          }}
        >
          {isFloatingMinimized ? (
            <button
              onMouseDown={handleMouseDown}
              onClick={() => setIsFloatingMinimized(false)}
              className="w-12 h-12 bg-zinc-900 border-2 border-red-600/50 rounded-full flex items-center justify-center shadow-[0_0_30px_rgba(220,38,38,0.3)]"
              title="Abrir reproductor"
            >
              <svg className="w-6 h-6 text-red-600" viewBox="0 0 24 24" fill="currentColor"><path d="M3 22v-20l18 10-18 10z" /></svg>
            </button>
          ) : (
            <div className={`bg-zinc-900 border-2 border-red-600/50 rounded-[2rem] p-6 shadow-[0_0_60px_rgba(220,38,38,0.4)] backdrop-blur-xl bg-opacity-95 w-[400px]`}>
              <div className="flex items-start justify-between mb-4 cursor-grab active:cursor-grabbing" onMouseDown={handleMouseDown}>
                <div className="flex-1 pointer-events-none">
                  <div className="flex items-center gap-3 mb-2">
                    <span className="w-2 h-2 rounded-full bg-red-600 animate-pulse"></span>
                    <span className="text-[10px] font-black uppercase tracking-widest text-red-600">Última Emisión</span>
                  </div>
                  <p className="text-[11px] text-zinc-500 font-mono">{getArtisticName(displayedHistory[0].voice || '')}</p>
                </div>

                <div className="flex items-center gap-2">
                  <button onClick={() => setShowHistoryModal(true)} className="p-2 hover:bg-red-600/20 rounded-xl transition-colors" title="Ver Archivo completo">
                    <svg className="w-5 h-5 text-zinc-600 group-hover:text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" /></svg>
                  </button>
                  <button onClick={() => setIsFloatingMinimized(true)} className="p-2 hover:bg-zinc-800 rounded-xl transition-colors" title="Minimizar">
                    <span className="text-zinc-400 font-black">-</span>
                  </button>
                </div>
              </div>

              <audio controls preload="auto" key={displayedHistory[0].audioUrl}>
                <source src={displayedHistory[0].audioUrl} type="audio/wav" />
                Tu navegador no soporta audio.
              </audio>

              <div className="flex gap-2 mt-4">
                <a href={displayedHistory[0].audioUrl} download={`palporro-${displayedHistory[0].id}.wav`} className="flex-1 px-4 py-2 bg-zinc-800 hover:bg-zinc-700 rounded-xl font-black uppercase text-[9px] tracking-wider transition-all flex items-center justify-center gap-2">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                  Descargar
                </a>
              </div>
            </div>
          )}
        </div>
      )}

      {/* VERSIÓN MÓVIL DEL REPRODUCTOR - Minimizable para no tapar footer */}
      {activeTab === 'dashboard' && (
        <div className={`fixed left-0 right-0 z-50 md:hidden transition-all duration-300 ${
          isFloatingMinimized ? 'bottom-4' : 'bottom-0'
        }`}>
          {isFloatingMinimized ? (
            // Versión minimizada - destacada pero compacta
            <div className="flex justify-center">
              <button
                onClick={() => setIsFloatingMinimized(false)}
                className="bg-gradient-to-r from-red-600 to-red-700 text-white px-6 py-3 rounded-full shadow-[0_0_30px_rgba(220,38,38,0.5)] flex items-center gap-3 border-2 border-red-500 hover:scale-105 transition-transform"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M3 22v-20l18 10-18 10z" />
                </svg>
                <span className="font-black uppercase tracking-wider text-sm">ÚLTIMA EMISIÓN</span>
                <span className="w-2 h-2 rounded-full bg-white animate-pulse"></span>
              </button>
            </div>
          ) : (
            // Versión expandida
            <div className="bg-zinc-900 border-t-2 border-red-600/50 shadow-[0_-10px_60px_rgba(220,38,38,0.4)] backdrop-blur-xl bg-opacity-95 p-4 safe-area-inset-bottom">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-3">
                  <span className="w-2 h-2 rounded-full bg-red-600 animate-pulse"></span>
                  <span className="text-[9px] font-black uppercase tracking-widest text-red-600">Última Emisión</span>
                </div>
                <div className="flex items-center gap-2">
                  <button 
                    onClick={() => setShowHistoryModal(true)} 
                    className="p-2 hover:bg-red-600/20 rounded-lg transition-colors"
                    title="Ver Archivo"
                  >
                    <svg className="w-4 h-4 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
                    </svg>
                  </button>
                  <button 
                    onClick={() => setIsFloatingMinimized(true)} 
                    className="p-2 hover:bg-zinc-800 rounded-lg transition-colors"
                    title="Minimizar"
                  >
                    <svg className="w-4 h-4 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                </div>
              </div>
              <audio controls className="w-full" preload="auto">
                <source src={displayedHistory[0].audioUrl} type="audio/wav" />
                Tu navegador no soporta audio.
              </audio>
            </div>
          )}
        </div>
      )}

      {/* PANEL DE DEBUG (solo en desarrollo) */}
      {process.env.NODE_ENV === 'development' && (
        <>
          {/* Botón para abrir/cerrar debug */}
          <button
            onClick={() => setDebugMode(!debugMode)}
            className="fixed bottom-4 left-4 z-[70] bg-purple-600 hover:bg-purple-700 text-white p-3 rounded-full shadow-2xl transition-all"
            title="Debug Tools"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>

          {/* Panel de debug */}
          {debugMode && (
            <div className="fixed bottom-20 left-4 z-[70] bg-zinc-900 border-2 border-purple-600 rounded-2xl p-6 shadow-2xl w-80">
              <div className="flex items-center justify-between mb-4 pb-4 border-b border-zinc-800">
                <h3 className="text-sm font-black uppercase text-purple-600">Debug Tools</h3>
                <button
                  onClick={() => setDebugMode(false)}
                  className="p-1 hover:bg-purple-600/20 rounded-lg transition-colors"
                >
                  <svg className="w-4 h-4 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

                <div className="space-y-4">
                  <div className="flex items-center justify-between p-3 bg-zinc-950 rounded-xl">
                    <span className="text-xs font-bold text-zinc-300">Forzar Votación</span>
                    <button
                      onClick={() => setForceVotingActive(!forceVotingActive)}
                      className={`px-4 py-2 rounded-lg font-black text-xs transition-all ${
                        forceVotingActive ? 'bg-green-600 text-white' : 'bg-zinc-800 text-zinc-400'
                      }`}
                    >
                      {forceVotingActive ? 'ON' : 'OFF'}
                    </button>
                  </div>

                  <div className="flex items-center justify-between p-3 bg-zinc-950 rounded-xl">
                    <span className="text-xs font-bold text-zinc-300">Modo Cuadrícula</span>
                    <button
                      onClick={() => {
                        const next = !useGridVoting;
                        setUseGridVoting(next);
                        try { localStorage.setItem('palporro_grid_voting', next ? '1' : '0'); } catch(e){}
                      }}
                      className={`px-4 py-2 rounded-lg font-black text-xs transition-all ${useGridVoting ? 'bg-blue-600 text-white' : 'bg-zinc-800 text-zinc-400'}`}
                    >
                      {useGridVoting ? 'GRID' : 'CLÁSICO'}
                    </button>
                  </div>

                  <div className="flex flex-col gap-2 p-3 bg-zinc-950 rounded-xl">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-zinc-300">TEST: Simular cutoff</span>
                      <button
                        onClick={() => {
                          const next = !devSimulateCutoff;
                          setDevSimulateCutoff(next);
                          try { localStorage.setItem('palporro_dev_cutoff_enabled', next ? '1' : '0'); } catch(e){}
                        }}
                        className={`px-3 py-1 rounded-lg font-black text-xs transition-all ${devSimulateCutoff ? 'bg-green-600 text-white' : 'bg-zinc-800 text-zinc-400'}`}
                      >
                        {devSimulateCutoff ? 'ON' : 'OFF'}
                      </button>
                    </div>

                    <div className="flex items-center gap-2">
                      <input
                        type="datetime-local"
                        value={devCutoffIso}
                        onChange={(e) => {
                          const v = e.target.value;
                          setDevCutoffIso(v);
                          try { localStorage.setItem('palporro_dev_cutoff', v); } catch(e){}
                        }}
                        className="w-full bg-zinc-800 text-zinc-200 p-2 rounded-lg text-xs"
                      />
                    </div>
                    <div className="text-[11px] text-zinc-400">Si está activado, la app usará esta fecha/hora como cutoff para filtrar votos.</div>
                    <div className="flex items-center gap-2 pt-2">
                      <div className="text-[11px] text-zinc-300">Cutoff efectivo:</div>
                      <div className="text-[11px] font-black text-purple-400">
                        {(() => {
                          try {
                            if (devSimulateCutoff && devCutoffIso) return new Date(devCutoffIso).toLocaleString();
                            const stored = localStorage.getItem('palporro_voting_start');
                            if (stored) return new Date(stored).toLocaleString();
                            // calcular último viernes 23:00
                            const now = new Date();
                            const day = now.getDay();
                            const daysSinceFri = (day >= 5) ? day - 5 : (7 - (5 - day));
                            const lastFri = new Date(now);
                            lastFri.setDate(now.getDate() - daysSinceFri);
                            lastFri.setHours(23,0,0,0);
                            return lastFri.toLocaleString();
                          } catch (e) { return 'N/A'; }
                        })()}
                      </div>
                      <button
                        onClick={async () => {
                          try {
                            const environment = getEnvironment();
                            const votes = await getRelevantVotes(environment);
                            const dayCount: Record<string, number> = {};
                            const timeCount: Record<string, number> = {};
                            votes.forEach((v: any) => (v.slots || []).forEach((s: any) => { dayCount[s.day] = (dayCount[s.day] || 0) + 1; timeCount[s.time] = (timeCount[s.time] || 0) + 1; }));
                            setVotingState(prev => ({ ...prev, allVotes: votes }));
                            setVotingStats({ totalVotes: votes.length, dayCount, timeCount });
                          } catch (err) { console.warn('Manual reload failed', err); }
                        }}
                        className="ml-auto px-3 py-1 rounded-lg bg-blue-600 text-white text-xs font-black"
                      >
                        Aplicar ahora
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center justify-between p-3 bg-zinc-950 rounded-xl">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-xs font-bold text-zinc-300">Sistema de Puntuación</span>
                    <span className="text-[10px] text-zinc-600">
                      {scoringSystem === 1 ? 'S1: Lineal' : 'S2: P1 ×1.5'}
                    </span>
                  </div>
                  <button
                    onClick={() => {
                      const next: 1 | 2 = scoringSystem === 1 ? 2 : 1;
                      setScoringSystem(next);
                      try { localStorage.setItem('palporro_scoring_system', String(next)); } catch(e) {}
                    }}
                    className={`px-4 py-2 rounded-lg font-black text-xs transition-all ${
                      scoringSystem === 2 ? 'bg-red-600 text-white' : 'bg-zinc-800 text-zinc-400'
                    }`}
                  >
                    S{scoringSystem}
                  </button>
                </div>
                  <button
                   onClick={() => {
                     setVotingState({
                       isOpen: false,
                       hasVoted: false,
                       selectedSlots: [],
                       selectedDays: [],
                       selectedTimes: [],
                       userPilot: votingState.userPilot,
                       allVotes: []
                     });
                     localStorage.removeItem('palporro_voting');
                   }}
                   className="w-full bg-red-600 hover:bg-red-700 text-white font-black py-3 rounded-xl text-xs uppercase transition-all"
                 >
                   Reset Votación
                 </button>

                <button
                  onClick={() => {
                    localStorage.removeItem('palporro_user_pilot');
                    setVotingState(prev => ({ ...prev, userPilot: null }));
                    setShowPilotSelector(true);
                  }}
                  className="w-full bg-orange-600 hover:bg-orange-700 text-white font-black py-3 rounded-xl text-xs uppercase transition-all"
                >
                  Reset Piloto
                </button>

                <div className="p-3 bg-zinc-950 rounded-xl text-xs space-y-2">
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Votación activa:</span>
                    <span className={`font-black ${isVotingActive() ? 'text-green-600' : 'text-red-600'}`}>
                      {isVotingActive() ? 'SÍ' : 'NO'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Ha votado:</span>
                    <span className={`font-black ${votingState.hasVoted ? 'text-green-600' : 'text-red-600'}`}>
                      {votingState.hasVoted ? 'SÍ' : 'NO'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Piloto:</span>
                    <span className="font-black text-purple-600">
                      {votingState.userPilot || 'N/A'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Total votos:</span>
                    <span className="font-black text-purple-600">
                      {votingState.allVotes.length}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* Easter egg toast */}
      {showEggToast && (
        <div className="egg-toast">Pit-stop secreto: cambiale la goma al alma 🏁</div>
      )}

      {/* PANEL DE VOTACIÓN LATERAL - SIEMPRE VISIBLE Y ACTIVO */}
      <>
        {/* Solapa para abrir/cerrar */}
        <button
          onClick={() => setVotingState(prev => ({ ...prev, isOpen: !prev.isOpen }))}
          className={`fixed right-0 top-1/2 -translate-y-1/2 z-[60] ${
            !votingState.hasVoted 
              ? 'bg-red-700 text-white shadow-2xl border-red-700 animate-pulse' 
              : 'bg-zinc-900 border-zinc-700'
          } rounded-l-2xl p-3 md:p-4 transition-all hover:pr-4 md:hover:pr-6 group border-2`}
          style={{ writingMode: 'vertical-rl' }}
          title="Abrir panel de votación"
        >
          <div className="flex items-center gap-2 md:gap-3">
            {!votingState.hasVoted && (
              <span className="w-2 h-2 md:w-3 md:h-3 bg-white rounded-full animate-ping"></span>
            )}
            <span className={`font-black uppercase tracking-widest text-xs md:text-sm ${
              !votingState.hasVoted ? 'text-white' : 'text-zinc-400'
            } group-hover:text-red-500`}>
              VOTACIÓN Próxima Fecha
            </span>
          </div>
        </button>

        {/* Panel de votación */}
        <div
            className={`fixed right-0 top-0 bottom-0 w-full md:w-[760px] bg-zinc-900 border-l-2 border-red-600/50 shadow-[0_0_60px_rgba(220,38,38,0.4)] z-50 transition-transform duration-500 overflow-y-auto ${
              votingState.isOpen ? 'translate-x-0' : 'translate-x-full'
            }`}
          >
            <div className="p-6">
              <h2 className="text-2xl font-black uppercase text-white mb-4">Votación Próxima Fecha</h2>
              <p className="text-zinc-300 mb-6">Elige el día y horario de la próxima carrera:</p>

              {/* Detalle de la próxima fecha y resumen de combinaciones */}
              <div className={`mb-4 p-3 rounded-lg ${(() => {
                const nr2 = getNextRaceInfo();
                if (!nr2) return 'bg-zinc-950 border border-zinc-800';
                return nr2.isDefinitive ? 'bg-green-950/20 border border-green-600/50' : 'bg-orange-950/20 border border-orange-600/50';
              })()} group/next`}>
                {(() => {
                  const nr = getNextRaceInfo();
                  const slotMap = getSlotCounts();
                  const combos = Object.values(slotMap).sort((a,b) => b.count - a.count);
                  return (
                    <div>
                      {nr ? (
                        <div className="flex items-start justify-between gap-4">
                          <div>
                            <div className={`text-[10px] font-black uppercase tracking-wider ${nr.hasDisagreement ? 'text-zinc-400' : (nr.isDefinitive ? 'text-green-600' : 'text-orange-500')}`}>
                              {nr.hasDisagreement ? 'NO HAY ACUERDO' : (nr.isDefinitive ? 'FECHA CONFIRMADA' : 'FECHA TENTATIVA')}
                            </div>
                            <div className="text-sm font-black text-white mt-1">{tracks[nextTrackIndex || 0]?.name || 'Próxima pista'}</div>
                            <div className="text-xs text-zinc-400">{nr.day} {nr.date.toLocaleDateString('es-AR', { day: '2-digit', month: 'short' })} • {nr.time}hs</div>
                          </div>
                          <div className="text-right">
                            <div className="text-xs text-zinc-400">Pilotos totales: <span className="font-black text-purple-400">{nr.totalVotes}</span></div>
                            <div className="text-xs text-zinc-400">Coincidencias en combinación: <span className="font-black text-red-500">{nr.votesForDate}</span></div>
                          </div>
                        </div>
                      ) : (
                        <div className="text-xs text-zinc-400">Aún no hay votos suficientes para proponer una fecha.</div>
                      )}

                        <div className="mt-3 text-xs">
                          <div className="font-black mb-2">Estado de la votación</div>
                          <div className="text-zinc-500">Aquí se muestra si hay fecha tentativa o confirmada.</div>
                        </div>

                        {/* Popover con detalle de combinaciones (aparece al hover) */}
                        <div className="absolute bottom-full left-0 right-0 mb-2 z-50 opacity-0 pointer-events-none group-hover/next:opacity-100 group-hover/next:pointer-events-auto transition-all duration-200 translate-y-1 group-hover/next:translate-y-0">
                          <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl overflow-hidden">
                            <div className="px-4 py-3 border-b border-zinc-800 bg-zinc-950/60 flex items-center justify-between">
                              <span className="text-[9px] font-black uppercase tracking-widest text-zinc-500">Detalle de combinaciones</span>
                              <span className="text-[9px] text-zinc-400">Total pilotos: {votingState.allVotes.length}</span>
                            </div>
                            <div className="divide-y divide-zinc-800/50 max-h-60 overflow-auto p-2">
                              {combos.length === 0 ? (
                                <div className="px-4 py-3 text-zinc-500">No hay combinaciones votadas aún.</div>
                              ) : combos.map(c => (
                                <div key={`${c.day}-${c.time}`} className="px-4 py-3 flex flex-col gap-1">
                                  <div className="flex items-center justify-between">
                                    <div className="font-black text-sm">{c.day} <span className="text-zinc-400 ml-2">{c.time}hs</span></div>
                                    <div className="text-red-500 font-black">{c.count}</div>
                                  </div>
                                  <div className="text-[11px] text-zinc-500">{c.pilots.length ? c.pilots.join(', ') : '—'}</div>
                                </div>
                              ))}
                            </div>
                          </div>
                          <div className="w-3 h-3 bg-zinc-900 border-r border-b border-zinc-700 rotate-45 mx-auto -mt-1.5"></div>
                        </div>
                    </div>
                  );
                })()}
              </div>

               {useGridVoting ? (
                 <div className="mb-6">
                   <h3 className="text-xl font-black uppercase text-white mb-2">Combinaciones (día × horario)</h3>
                   <div className="overflow-auto">
                     <table className="w-full table-fixed border-collapse">
                       <thead>
                         <tr>
                           <th className="p-2 text-left text-xs text-zinc-400">Día \ Hora</th>
                           {VOTING_TIMES.map(t => (
                             <th key={t} className="p-2 text-center text-xs text-zinc-400">{t}</th>
                           ))}
                         </tr>
                       </thead>
                       <tbody>
                         {VOTING_DAYS.map(day => (
                           <tr key={day} className="border-t border-zinc-800">
                             <td className="p-2 text-sm font-black text-zinc-200">{day}</td>
                             {VOTING_TIMES.map(t => {
                               const sel = votingState.selectedSlots.some(s => s.day === day && s.time === t);
                               return (
                                 <td key={t} className="p-2 text-center">
                                   <button
                                     onClick={() => toggleSlot(day, t)}
                                     className={`px-3 py-2 rounded-lg text-xs font-black transition-all ${sel ? 'bg-red-600 text-white' : 'bg-zinc-800 text-zinc-300'}`}
                                   >
                                     {sel ? '✓' : '+'}
                                   </button>
                                 </td>
                               );
                             })}
                           </tr>
                         ))}
                       </tbody>
                     </table>
                   </div>
                   <p className="text-[11px] text-zinc-500 mt-2">Haz clic en las casillas para seleccionar combinaciones específicas de día y horario.</p>
                 </div>
               ) : (
                 <>
                   <div className="mb-6">
                     <h3 className="text-xl font-black uppercase text-white mb-2">Día:</h3>
                     <div className="grid grid-cols-2 gap-4">
                       {VOTING_DAYS.map(day => (
                         <button
                           key={day}
                           onClick={() => toggleDay(day)}
                           className={`w-full p-4 rounded-lg border-2 ${
                             votingState.selectedDays.includes(day) ? 'bg-red-600 text-white' : 'bg-zinc-800 text-zinc-300'
                           } transition-colors`}
                         >
                           {day}
                         </button>
                       ))}
                     </div>
                   </div>

                   <div className="mb-6">
                     <h3 className="text-xl font-black uppercase text-white mb-2">Horario:</h3>
                     <div className="grid grid-cols-2 gap-4">
                       {VOTING_TIMES.map(time => (
                         <button
                           key={time}
                           onClick={() => toggleTime(time)}
                           className={`w-full p-4 rounded-lg border-2 ${
                             votingState.selectedTimes.includes(time) ? 'bg-red-600 text-white' : 'bg-zinc-800 text-zinc-300'
                           } transition-colors`}
                         >
                           {time}
                         </button>
                       ))}
                     </div>
                   </div>
                 </>
               )}

              <div className="mb-6">
                <h3 className="text-xl font-black uppercase text-white mb-2">Piloto:</h3>
                {showPilotSelector ? (
                  <div className="grid grid-cols-2 gap-4">
                    {PILOTS.map(pilot => (
                      <button
                        key={pilot}
                        onClick={() => handlePilotSelection(pilot)}
                        className="w-full p-4 rounded-lg border-2 bg-zinc-800 text-zinc-300 transition-colors"
                      >
                        {pilot}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="p-4 bg-zinc-800 text-zinc-300 rounded-lg">
                    {votingState.userPilot!}
                  </div>
                )}
              </div>

              <button
                onClick={handleVoteSubmit}
                disabled={isSubmittingVote || (votingState.hasVoted && !pendingVoteChange)}
                className={`w-full p-4 font-black rounded-lg uppercase text-sm tracking-widest transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
                  pendingVoteChange ? 'bg-red-700 text-white hover:bg-red-800 cursor-pointer' : (votingState.hasVoted ? 'bg-zinc-700 text-zinc-300' : 'bg-red-600 text-white hover:bg-red-700 cursor-pointer')
                }`}
              >
                {isSubmittingVote ? 'Guardando...' : (pendingVoteChange ? 'Confirmar cambios' : (votingState.hasVoted ? 'Votaste! Gracias' : 'Votar!'))}
              </button>
            </div>
          </div>
        </> 
      {/* Fin del panel de votación - siempre visible */}

      <main className="max-w-[1600px] mx-auto p-2 md:p-4 lg:p-8 relative z-10 space-y-4 md:space-y-8 pb-32 md:pb-8">
          {activeTab === 'dashboard' ? (
          <div className="flex flex-col gap-4 md:gap-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
            
            {/* 1. FiaScore Banner */}
            <section className={`w-full bg-zinc-900 border ${fiaScoreData.isPending ? 'border-zinc-800' : 'border-red-600/30'} rounded-[2.5rem] p-6 md:p-14 shadow-[0_0_60px_rgba(0,0,0,0.6)] relative overflow-hidden transition-all duration-700 flex flex-col md:flex-row items-center justify-between gap-6 md:gap-8`}>
               <div className="relative z-10 text-center md:text-left flex-1">
                  <p className="text-[10px] md:text-[11px] font-black text-zinc-500 uppercase tracking-[0.6em] md:tracking-[0.8em] mb-3 md:mb-4 italic">Monitor de Estabilidad de Temporada</p>
                   <h3 className="text-5xl md:text-8xl font-black italic uppercase text-white tracking-tighter leading-none">
                      <span className="text-red-600 drop-shadow-[0_0_20px_rgba(220,38,38,0.6)]">FiaSco</span>Re
                  </h3>
                  <div className="mt-6 md:mt-8 bg-black/30 p-4 md:p-6 rounded-2xl md:rounded-3xl border-l-4 border-red-600 inline-block backdrop-blur-md hidden md:block">
                    <p className="text-[12px] md:text-[16px] text-zinc-300 font-black uppercase tracking-[0.1em] max-w-xl italic leading-relaxed">
                      "Sistema de análisis de estabilidad : Evaluando la adhesión de pilotos, el respeto en pista y el inminente riesgo de fracaso."
                    </p>
                  </div>
               </div>

                <div className="relative z-10 flex flex-col items-center md:items-end w-full md:w-auto">
                  <div className="flex items-center gap-4 md:gap-6 mb-4 md:mb-6">
                    <span className={`text-6xl md:text-8xl font-black italic tabular-nums leading-none ${fiaScoreData.isPending ? 'text-zinc-800' : ''}`} onClick={handleFiaScoreClick} role="button" tabIndex={0}>
                      {fiaScoreData.label}
                    </span>
                  </div>
                  <div className="w-full md:w-[350px] h-10 md:h-12 bg-zinc-950 rounded-full border border-zinc-800 p-2 overflow-hidden shadow-inner">
                    {!fiaScoreData.isPending ? (
                      <div className="h-full bg-gradient-to-r from-red-950 via-red-600 to-red-400 rounded-full transition-all duration-[2s] ease-out shadow-[0_0_30px_rgba(220,38,38,0.8)]" style={{ width: `${fiaScoreData.value}%` }}></div>
                    ) : (
                      <div className="h-full w-full bg-zinc-900 flex items-center justify-center gap-4">
                        {[0, 1, 2].map(i => <div key={i} className="w-2 h-2 bg-zinc-800 rounded-full animate-pulse" style={{ animationDelay: `${i*0.2}s` }}></div>)}
                      </div>
                    )}
                  </div>
               </div>
               <div className="absolute top-1/2 left-1/4 -translate-y-1/2 opacity-[0.03] pointer-events-none scale-150"><img src="/Logo.jpg" alt="" className="w-full max-w-2xl h-auto grayscale" /></div>
            </section>

            {/* 2. Clasificación y Tour */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch">
              <section className="lg:col-span-8 bg-zinc-900 border border-zinc-800 rounded-[2rem] overflow-hidden shadow-2xl flex flex-col">
                <div className="bg-gradient-to-r from-zinc-800 to-zinc-900 p-6 border-b border-zinc-700 flex justify-between items-center">
                  <h2 className="text-[14px] font-black uppercase tracking-[0.2em] flex items-center gap-4 italic text-zinc-100">
                    <div className="w-2 h-6 bg-red-600 shadow-[0_0_15px_rgba(220,38,38,0.7)]"></div>
                    Clasificación Palporro Febrero 26
                  </h2>
                </div>
                <div className="overflow-x-auto flex-1">
                  <table className="w-full text-left min-w-[600px]">
                    <thead>
                      <tr className="text-[10px] uppercase text-zinc-600 bg-zinc-950/40 border-b border-zinc-800/50">
                        <th className="px-3 md:px-6 py-5 font-black">Pos</th>
                        <th className="px-3 md:px-6 py-5 font-black">Piloto</th>
                        <th className="px-3 md:px-6 py-5 font-black text-center" title="Grandes Premios">GP</th>
                        <th className="px-3 md:px-6 py-5 font-black text-center" title="Incidencias">INC</th>
                        <th className="px-3 md:px-6 py-5 font-black text-right" title="Puntos">PTS</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800/20">
                      {standings.sort((a,b) => b.points - a.points).map((s, idx) => (
                        <tr key={s.pilot} className="group hover:bg-zinc-800/30 transition-all cursor-crosshair">
                          <td className="px-3 md:px-6 py-4 md:py-6 text-[10px] md:text-[12px] font-mono text-zinc-700 font-black italic">#{idx + 1}</td>
                          <td className="px-3 md:px-6 py-4 md:py-6"><div className="text-[13px] md:text-[16px] font-black uppercase italic group-hover:text-red-500 transition-colors flex items-center gap-2 md:gap-3">{s.pilot}{idx === 0 && <span className="text-[7px] md:text-[8px] bg-red-600 text-white px-1.5 md:px-2 py-0.5 rounded italic font-black">P1</span>}
                            {(() => {
                              const nextRace = getNextRaceInfo();
                              const pilotVote = (votingState.allVotes ?? []).find(v => v.pilot === s.pilot);
                              const isConfirmed = nextRace && nextRace.isDefinitive && pilotVote && ((pilotVote.slots ?? []) as any).some((ss: any) => ss.day === nextRace.day && ss.time === nextRace.time);
                              const isTentative = !!pilotVote && !isConfirmed;
                              if (isConfirmed) {
                                return (<span className="ml-2 px-2 py-0.5 text-[9px] font-black rounded bg-green-600 text-white">Confirmado</span>);
                              }
                              if (isTentative) {
                                return (<span className="ml-2 px-2 py-0.5 text-[9px] font-black rounded bg-yellow-600 text-black">Tentativo</span>);
                              }
                              return null;
                            })()}
                          </div><div className="text-[9px] md:text-[10px] text-zinc-500 uppercase font-black mt-1 opacity-60">{s.lastResult}</div></td>
                          <td className="px-3 md:px-6 py-4 md:py-6 text-center text-[11px] md:text-[13px] font-mono font-black text-zinc-500">{s.racesRun}</td>
                          <td className="px-3 md:px-6 py-4 md:py-6 text-center text-[11px] md:text-[13px] font-mono font-black text-red-900 group-hover:text-red-600">{s.incidences}</td>
                          <td className="px-3 md:px-6 py-4 md:py-6 text-right font-black text-red-600 text-xl md:text-3xl tabular-nums">{s.points}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="px-6 py-4 bg-zinc-950/40 border-t border-zinc-800">
                  <div className="flex flex-wrap gap-4 md:gap-6 justify-center md:justify-start text-[9px] md:text-[10px] text-zinc-600 uppercase font-black">
                    <div className="flex items-center gap-2">
                      <span className="text-zinc-500">GP:</span>
                      <span className="text-zinc-400">Grandes Premios</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-zinc-500">INC:</span>
                      <span className="text-zinc-400">Incidencias</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-zinc-500">PTS:</span>
                      <span className="text-zinc-400">Puntos</span>
                    </div>
                  </div>
                </div>
              </section>

              <section className="lg:col-span-4 bg-zinc-900 border border-zinc-800 rounded-[2rem] p-8 shadow-2xl flex flex-col">
                <div className="flex flex-col mb-8 border-b border-zinc-800 pb-6">
                  <h2 className="text-[13px] font-black uppercase tracking-[0.3em] text-zinc-400 flex items-center gap-3 italic mb-2">
                    <div className="w-4 h-4 bg-red-600/20 border border-red-600 rotate-45"></div>
                    Liga Febrero 2026
                  </h2>
                  
                  {/* Mostrar fecha tentativa/definitiva */}
{(() => {
  const nextRace = getNextRaceInfo();

  // Sin votos aún
  if (!nextRace || nextRace.totalVotes === 0) {
    return (
      <p className="text-[9px] text-zinc-600 uppercase font-black tracking-widest italic mt-2">
        * Haz clic en una pista para ver resultados
      </p>
    );
  }

  // Hay votos pero no hay acuerdo (ninguna combinación tiene 2+)
  if (nextRace.hasDisagreement) {
    return (
      <div className="mt-3 relative group/disagreement">
        <div className="p-4 rounded-xl border-2 bg-red-950/20 border-red-600/40 cursor-help transition-all duration-200 group-hover/disagreement:border-red-500/70 group-hover/disagreement:bg-red-950/30">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
              <span className="text-[10px] font-black uppercase tracking-widest text-red-500">
                No hay acuerdo
              </span>
            </div>
            <span className="text-[9px] text-zinc-600 font-black uppercase tracking-wider opacity-0 group-hover/disagreement:opacity-100 transition-opacity duration-200">
              ver votos ↑
            </span>
          </div>
          <p className="text-xs text-zinc-500">
            {nextRace.totalVotes} pilotos votaron sin coincidir
          </p>
        </div>

        {/* Popover con detalle de votos */}
        <div className="absolute bottom-full left-0 right-0 mb-2 z-50 opacity-0 pointer-events-none group-hover/disagreement:opacity-100 group-hover/disagreement:pointer-events-auto transition-all duration-200 translate-y-1 group-hover/disagreement:translate-y-0">
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl overflow-hidden">
            <div className="px-4 py-3 border-b border-zinc-800 bg-zinc-950/60">
              <span className="text-[9px] font-black uppercase tracking-widest text-zinc-500">
                Votos actuales
              </span>
            </div>
            <div className="divide-y divide-zinc-800/50 px-4 py-2">
              {/* Mostrar votos agrupados por día -> horario -> pilotos */}
              {(() => {
                const map: Record<string, Record<string, string[]>> = {};
                (votingState.allVotes ?? []).forEach(vote => {
                  const pilot = vote.pilot;
                  (vote.slots || []).forEach((s: any) => {
                    if (!s || !s.day) return;
                    if (!map[s.day]) map[s.day] = {};
                    if (!map[s.day][s.time]) map[s.day][s.time] = [];
                    if (!map[s.day][s.time].includes(pilot)) map[s.day][s.time].push(pilot);
                  });
                });

                // compute max count per day so we can highlight the leading timeslot
                const maxPerDay: Record<string, number> = {};
                Object.keys(map).forEach(d => {
                  const times = Object.values(map[d]);
                  let m = 0;
                  times.forEach(arr => { if (arr.length > m) m = arr.length; });
                  maxPerDay[d] = m;
                });

                return VOTING_DAYS.map(day => {
                  const times = map[day] ? Object.entries(map[day]) : [];
                  return (
                    <div key={day} className="py-2">
                      <div className="text-[11px] font-black uppercase text-zinc-200 mb-2">{day}</div>
                      {times.length === 0 ? (
                        <div className="text-[9px] text-zinc-500">No hay votos para este día.</div>
                      ) : (
                        <div className="flex flex-col gap-2">
                          {times.sort((a,b) => a[0].localeCompare(b[0])).map(([time, pilots]) => {
                            const isTop = pilots.length > 0 && pilots.length === (maxPerDay[day] || 0);
                            return (
                              <div key={time} className="flex flex-col">
                                <div className="flex items-center gap-3">
                                  <span className={`text-[9px] font-black px-2 py-0.5 rounded-full ${isTop ? 'bg-red-600/20 text-red-400 border border-red-600/30' : 'bg-zinc-800 text-zinc-300 border border-zinc-700'}`}>{time}hs</span>
                                  <span className={`text-[9px] ${isTop ? 'text-red-400 font-black' : 'text-zinc-400'}`}>{pilots.length} piloto{pilots.length !== 1 ? 's' : ''}</span>
                                </div>
                                <div className={`ml-10 ${isTop ? 'text-[12px] font-bold text-zinc-100' : 'text-[11px] text-zinc-500'}`}>{pilots.join(', ')}</div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                });
              })()}
            </div>
          </div>
          {/* Flecha del popover */}
          <div className="w-3 h-3 bg-zinc-900 border-r border-b border-zinc-700 rotate-45 mx-auto -mt-1.5"></div>
        </div>
      </div>
    );
  }

  // Hay acuerdo — mostrar fecha tentativa o confirmada
  if (nextRace && nextTrackIndex !== -1) {
    return (
      <div className={`mt-3 relative ${!nextRace.isDefinitive && nextRace.totalVotes >= 2 ? 'group/tentative' : ''}`}>
        <div className={`p-4 rounded-xl border-2 ${
          nextRace.isDefinitive
            ? 'bg-green-950/20 border-green-600/50'
            : 'bg-orange-950/20 border-orange-600/50 cursor-help transition-all duration-200 group-hover/tentative:border-orange-500/70 group-hover/tentative:bg-orange-950/30'
        }`}>
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              <span className={`text-[10px] font-black uppercase tracking-widest ${
                nextRace.isDefinitive ? 'text-green-600' : 'text-orange-600'
              }`}>
                {nextRace.isDefinitive ? 'FECHA CONFIRMADA' : 'FECHA TENTATIVA'}
              </span>
            </div>
            {!nextRace.isDefinitive && nextRace.totalVotes >= 2 && (
              <span className="text-[9px] text-zinc-600 font-black uppercase tracking-wider opacity-0 group-hover/tentative:opacity-100 transition-opacity duration-200">
                ver votos ↑
              </span>
            )}
          </div>
          <p className="text-sm font-black text-white mb-1">
            {tracks[nextTrackIndex].name}
          </p>
          <p className="text-xs text-zinc-400">
            {nextRace.day} {nextRace.date.toLocaleDateString('es-AR', { day: '2-digit', month: 'short' })} • {nextRace.time}hs
          </p>
          <p className="text-[10px] text-zinc-600 mt-2">
            {nextRace.votesForDate} de {nextRace.totalVotes} pilotos coinciden
          </p>
        </div>

        {/* Popover con detalle de votos - solo para fechas tentativas con 2+ votos */}
        {!nextRace.isDefinitive && nextRace.totalVotes >= 2 && (
          <div className="absolute bottom-full left-0 right-0 mb-2 z-50 opacity-0 pointer-events-none group-hover/tentative:opacity-100 group-hover/tentative:pointer-events-auto transition-all duration-200 translate-y-1 group-hover/tentative:translate-y-0">
            <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl overflow-hidden">
              <div className="px-4 py-3 border-b border-zinc-800 bg-zinc-950/60">
                <span className="text-[9px] font-black uppercase tracking-widest text-zinc-500">
                  Votos actuales
                </span>
              </div>
              <div className="divide-y divide-zinc-800/50 px-4 py-2">
                {/* Agrupar votos por día -> horario -> pilotos (igual que en el otro popover) */}
                {(() => {
                  const map: Record<string, Record<string, string[]>> = {};
                  (votingState.allVotes ?? []).forEach(vote => {
                    const pilot = vote.pilot;
                    (vote.slots || []).forEach((s: any) => {
                      if (!s || !s.day) return;
                      if (!map[s.day]) map[s.day] = {};
                      if (!map[s.day][s.time]) map[s.day][s.time] = [];
                      if (!map[s.day][s.time].includes(pilot)) map[s.day][s.time].push(pilot);
                    });
                  });

                  return VOTING_DAYS.map(day => {
                    const times = map[day] ? Object.entries(map[day]) : [];
                    return (
                      <div key={day} className="py-2">
                        <div className="text-[11px] font-black uppercase text-zinc-200 mb-2">{day}</div>
                        {times.length === 0 ? (
                          <div className="text-[9px] text-zinc-500">No hay votos para este día.</div>
                        ) : (
                          <div className="flex flex-col gap-2">
                            {times.sort((a,b) => a[0].localeCompare(b[0])).map(([time, pilots]) => (
                              <div key={time} className="flex flex-col">
                                <div className="flex items-center gap-3">
                                  <span className="text-[9px] font-black px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-300 border border-zinc-700">{time}hs</span>
                                  <span className="text-[9px] text-zinc-400">{pilots.length} piloto{pilots.length !== 1 ? 's' : ''}</span>
                                </div>
                                <div className="text-[11px] text-zinc-500 ml-10">{pilots.join(', ')}</div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  });
                })()}
              </div>
            </div>
            {/* Flecha del popover */}
            <div className="w-3 h-3 bg-zinc-900 border-r border-b border-zinc-700 rotate-45 mx-auto -mt-1.5"></div>
          </div>
        )}
      </div>
    );
  }

  return null;
})()}
                </div>
                <div className="space-y-3 overflow-y-auto max-h-[600px] pr-2 custom-scrollbar flex-1">
                  {(() => {
                    // Reordenar: completadas → próxima pista → resto pendientes
                    const nextTrack = nextTrackIndex !== -1 ? tracks[nextTrackIndex] : null;
                    const completed = tracks.filter(t => t.completed);
                    const pending = tracks.filter(t => !t.completed && t !== nextTrack);
                    const ordered = [
                      ...completed,
                      ...(nextTrack ? [nextTrack] : []),
                      ...pending
                    ];
                    return ordered;
                  })().map((t) => {
                    const idx = tracks.indexOf(t);
                    const isNext = idx === nextTrackIndex;
                    const isTraining = idx === 0;
                    const hasVotes = votingState.allVotes.length > 0;
                    const isFirstIncomplete = !t.completed && tracks.slice(0, idx).every(prev => prev.completed);
                    
                    return (
                      <React.Fragment key={t.name}>
                        {/* Mostrar "Pendiente de votación" justo antes de la primera pista no completada */}
                        {isFirstIncomplete && !hasVotes && (
                          <div className="w-full p-6 rounded-xl border-2 bg-gradient-to-br from-red-950/40 to-zinc-900/40 border-red-600/70 shadow-xl shadow-red-900/20 flex flex-col items-center justify-center relative overflow-hidden">
                            <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-red-600 shadow-[2px_0_15px_rgba(220,38,38,1)]"></div>
                            <div className="absolute inset-0 bg-gradient-to-r from-red-600/5 to-transparent pointer-events-none"></div>
                            <div className="flex flex-col items-center gap-3 text-center relative z-10">
                              <div className="relative">
                                <svg className="w-12 h-12 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                                </svg>
                                <div className="absolute -top-1 -right-1 w-3 h-3 bg-red-600 rounded-full animate-ping"></div>
                                <div className="absolute -top-1 -right-1 w-3 h-3 bg-red-600 rounded-full"></div>
                              </div>
                              <span className="text-[15px] font-black uppercase italic tracking-tighter text-red-400">⚠️ Pendiente de votación</span>
                              <span className="text-[11px] text-red-300/60 font-mono tracking-wide">Esperando primer voto para definir próxima pista</span>
                            </div>
                          </div>
                        )}
                        
                        {/* Renderizar la pista */}
                        <button onClick={() => handleTrackClick(t.name)} className={`w-full p-4 rounded-xl border transition-all flex items-center justify-between relative overflow-hidden group ${t.completed ? 'bg-zinc-800/20 border-zinc-700 hover:border-red-600/40' : isNext && hasVotes ? 'bg-zinc-900 border-red-600/50 shadow-xl' : 'bg-zinc-950 border-zinc-800 hover:border-zinc-600'}`}>
                          {isNext && hasVotes && <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-red-600 shadow-[2px_0_15px_rgba(220,38,38,1)]"></div>}
                          <div className="flex items-center gap-5">
                              <span className={`text-[11px] font-mono font-black ${t.completed ? 'text-zinc-500' : isNext && hasVotes ? 'text-red-600' : 'text-zinc-700'}`}>{idx < 10 ? `0${idx}` : idx}</span>
                              <span className={`text-[14px] font-black uppercase italic tracking-tighter ${t.completed ? 'text-zinc-400 group-hover:text-zinc-100' : isNext && hasVotes ? 'text-white' : 'text-zinc-300'}`}>{t.name}</span>
                          </div>
                          <div className={`w-8 h-8 rounded-lg border flex items-center justify-center ${t.completed ? 'bg-zinc-800 border-zinc-700' : isNext && hasVotes ? 'bg-red-600/10' : 'border-zinc-800'}`}>
                            {t.completed ? <svg className="w-5 h-5 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M9 5l7 7-7 7" /></svg> : isNext && hasVotes ? <div className="w-2.5 h-2.5 bg-red-600 rounded-full animate-ping"></div> : null}
                          </div>
                        </button>
                      </React.Fragment>
                    );
                  })}
                </div>
              </section>
            </div>

            {/* 3. Procesador IA */}
            <section className="w-full bg-zinc-900 border border-zinc-800 rounded-[2.5rem] p-10 md:p-14 shadow-2xl relative group overflow-hidden">
                <div className="flex items-center gap-6 mb-10">
                    <div className="p-5 bg-red-600 rounded-2xl shadow-2xl -rotate-3 border-b-4 border-red-900"><svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg></div>
                    <div><h2 className="text-2xl font-black uppercase tracking-tight text-white italic leading-none">Procesador IA de Telemetría</h2><p className="text-[10px] text-zinc-500 uppercase font-black mt-2 tracking-[0.4em]">Neural Bridge v4.26</p></div>
                </div>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
                  <div className="space-y-6">
                    <div className="relative">
                      <textarea 
                        value={metricsInput} 
                        onChange={(e) => setMetricsInput(e.target.value)} 
                        placeholder="Pegá aquí el JSON raw de Assetto Corsa Server Manager..." 
                        className="w-full h-80 bg-zinc-950 border border-zinc-800 rounded-[2rem] p-8 font-mono text-[12px] text-zinc-400 focus:outline-none focus:border-red-600 transition-all resize-none shadow-2xl placeholder:opacity-20" 
                      />
                      <div className="absolute top-4 right-4 text-[9px] text-zinc-600 font-black uppercase tracking-wider">
                        JSON Input
                      </div>
                    </div>
                    <button 
                      onClick={handleAnalyzeMetrics} 
                      disabled={isAnalyzing || !metricsInput} 
                      className="w-full bg-gradient-to-r from-red-600 to-red-700 text-white font-black py-7 rounded-[1.5rem] uppercase text-[12px] tracking-[0.5em] hover:from-red-700 hover:to-red-800 transition-all shadow-2xl disabled:opacity-20 flex items-center justify-center gap-6 border-b-4 border-red-900 active:border-b-0 active:translate-y-1"
                    >
                      {isAnalyzing ? (
                        <>
                          <div className="animate-spin h-6 w-6 border-4 border-white border-t-transparent rounded-full" />
                          <span>Procesando...</span>
                        </>
                      ) : (
                        <>
                          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M13 10V3L4 14h7v7l9-11h-7z" />
                          </svg>
                          <span>Procesar Telemetría</span>
                        </>
                      )}
                    </button>
                  </div>
                  
                  {/* Área de salida mejorada */}
                  <div className={`flex-1 min-h-[300px] rounded-[2rem] p-6 flex flex-col relative ${
                    analysis 
                      ? 'bg-zinc-950 border-2 border-green-600/30' 
                      : 'bg-zinc-950/40 border-2 border-dashed border-zinc-800'
                  }`}>
                    {!analysis && !isAnalyzing && (
                      <div className="flex-1 flex flex-col items-center justify-center opacity-20 italic space-y-4">
                        <svg className="w-20 h-20 text-zinc-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        <p className="text-2xl font-black uppercase tracking-tighter text-zinc-700">Esperando JSON</p>
                        <p className="text-xs text-zinc-700">Pegá el JSON raw y procesalo</p>
                      </div>
                    )}
                    
                    {analysis && (
                      <div className="flex-1 flex flex-col animate-in zoom-in-95 duration-700">
                        <div className="flex items-center justify-between mb-4">
                          <h4 className="text-[10px] font-black uppercase text-green-500 tracking-[0.6em] italic">
                            JSON Procesado
                          </h4>
                          <button
                            onClick={() => {
                              navigator.clipboard.writeText(analysis);
                              alert('✅ JSON copiado al portapapeles');
                            }}
                            className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg text-xs font-black uppercase tracking-wider transition-all flex items-center gap-2"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                            </svg>
                            Copiar JSON
                          </button>
                        </div>
                        <div className="flex-1 bg-black/40 rounded-xl p-4 overflow-auto border border-green-900/30">
                          <pre className="text-[11px] text-green-300 font-mono leading-relaxed whitespace-pre-wrap break-words">
                            {(() => {
                              try {
                                return JSON.stringify(JSON.parse(analysis), null, 2);
                              } catch {
                                return analysis;
                              }
                            })()}
                          </pre>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
            </section>
          </div>

        ) : activeTab === 'history' ? (
        /* PANTALLA ARCHIVO (EMISIONES) - muestra emisiones de radio */
        <div className="flex items-center justify-center min-h-[60vh] animate-in fade-in slide-in-from-right-4 duration-700">
          <div className="bg-zinc-900 border-2 border-zinc-800 rounded-[3rem] p-12 md:p-16 shadow-2xl max-w-2xl w-full">
            <div className="text-center mb-10">
              <div className="inline-block p-6 bg-red-600/10 rounded-3xl mb-6">
                <svg className="w-16 h-16 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
                </svg>
              </div>
              <h2 className="text-3xl font-black uppercase italic text-white mb-3">Archivo de Emisiones</h2>
              <p className="text-sm text-zinc-500 font-black uppercase tracking-wider">Archivo completo de emisiones de radio</p>
            </div>
            <div className="p-8 space-y-8">
              {(() => {
                const first = displayedHistory[0];
                const hasReal = emissionHistory.length > 0;
                return (
                  <div className="bg-zinc-950 p-6 md:p-8 rounded-2xl border border-zinc-800 flex flex-col md:flex-row items-start gap-6">
                    <div className="flex-1">
                      <div className="flex items-center justify-between">
                        <div className="font-black uppercase text-lg">{first.voice} { !hasReal && <span className="ml-2 text-xs text-zinc-400 font-normal">(Emisión por defecto)</span> }</div>
                        <div className="text-[10px] text-zinc-500">{new Date(first.timestamp).toLocaleString('es-AR')}</div>
                      </div>
                      <div className="text-zinc-300 italic mt-3 text-sm script-hidden">"Guion disponible"</div>
                      <audio controls src={first.audioUrl} className="w-full mt-4 rounded-lg" />
                    </div>

                    <div className="flex flex-col gap-3 md:gap-4 md:w-40">
                      <a href={first.audioUrl} download={`palporro-${first.id}.wav`} className="px-4 py-3 bg-zinc-800 rounded uppercase text-[11px] font-black text-center">Descargar</a>
                      {hasReal ? (
                        <button onClick={() => handleDeleteEmission(first.id)} className="px-4 py-3 bg-red-700 rounded uppercase text-[11px] font-black">Borrar</button>
                      ) : (
                        <button disabled className="px-4 py-3 bg-zinc-700 rounded uppercase text-[11px] font-black opacity-60">No editable</button>
                      )}
                    </div>
                  </div>
                );
              })()}

              {emissionHistory.length > 1 && (
                <div className="space-y-4">
                  {emissionHistory.slice(1).map(e => (
                    <div key={e.id} className="bg-zinc-950 p-4 rounded-2xl border border-zinc-800 flex items-start gap-4">
                      <div className="flex-1">
                        <div className="flex items-center justify-between">
                         <div className="font-black uppercase">{getArtisticName(e.voice)}</div>
                          <div className="text-[10px] text-zinc-500">{new Date(e.timestamp).toLocaleString('es-AR')}</div>
                        </div>
                        <div className="text-zinc-300 italic mt-2 script-hidden">"Guion disponible"</div>
                        <audio controls src={e.audioUrl} className="w-full mt-3" />
                      </div>
                      <div className="flex flex-col gap-2">
                        <a href={e.audioUrl} download={`palporro-${e.id}.wav`} className="px-3 py-2 bg-zinc-800 rounded uppercase text-[10px] font-black">Descargar</a>
                        <button onClick={() => handleDeleteEmission(e.id)} className="px-3 py-2 bg-red-700 rounded uppercase text-[10px] font-black">Borrar</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        ) : !isRadioUnlocked ? (
          /* PANTALLA DE ACCESO A RADIO */
          <div className="flex items-center justify-center min-h-[60vh] animate-in fade-in slide-in-from-right-4 duration-700">
            <div className="bg-zinc-900 border-2 border-zinc-800 rounded-[3rem] p-12 md:p-16 shadow-2xl max-w-md w-full">
              <div className="text-center mb-10">
                <div className="inline-block p-6 bg-red-600/10 rounded-3xl mb-6">
                  <svg className="w-16 h-16 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                  </svg>
                </div>
                <h2 className="text-3xl font-black uppercase italic text-white mb-3">Acceso Restringido</h2>
                <p className="text-sm text-zinc-500 font-black uppercase tracking-wider">Estudio de Radio Palporro</p>
              </div>
              <div className="space-y-6">
                <div>
                  <label className="text-xs font-black uppercase text-zinc-600 tracking-widest ml-4 block mb-3">Código de Acceso</label>
                  <input
                    type="password"
                    value={radioAccessCode}
                    onChange={(e) => setRadioAccessCode(e.target.value)}
                    onKeyPress={(e) => {
                      if (e.key === 'Enter' && radioAccessCode === RADIO_CODE) {
                        setIsRadioUnlocked(true);
                      }
                    }}
                    placeholder="••••"
                    className="w-full bg-zinc-950 border-2 border-zinc-800 rounded-2xl p-6 text-center text-2xl font-black tracking-widest text-zinc-100 focus:outline-none focus:border-red-600 transition-all"
                    maxLength={4}
                  />
                </div>
                <button
                  onClick={() => {
                    if (radioAccessCode === RADIO_CODE) {
                      setIsRadioUnlocked(true);
                    } else {
                      setRadioAccessCode('');
                      alert('Código incorrecto');
                    }
                  }}
                  className="w-full bg-red-600 text-white font-black py-6 rounded-2xl uppercase text-sm tracking-widest hover:bg-red-700 transition-all shadow-xl border-b-4 border-red-900 active:border-b-0 active:translate-y-1"
                >
                  Ingresar al Estudio
                </button>
              </div>
            </div>
          </div>
        ) : (
          /* ESTUDIO DE RADIO */
          <div className="flex flex-col gap-4 md:gap-8 animate-in fade-in slide-in-from-right-4 duration-700">
            <aside className="lg:col-span-3 space-y-6">
              <div className="bg-zinc-900 border border-zinc-800 p-10 rounded-[2.5rem] shadow-2xl sticky top-28">
                <h3 className="text-red-600 font-black text-[13px] uppercase tracking-[0.4em] mb-10 border-b border-zinc-800 pb-5 italic">Voces</h3>
                <div className="space-y-5">
                  {VOICE_OPTIONS.map((voice) => (
                    <button key={voice.id} onClick={() => setSelectedVoice(voice.id)} className={`w-full text-left p-6 rounded-[1.5rem] border transition-all group ${selectedVoice === voice.id ? 'bg-red-600/5 border-red-600 text-red-500 shadow-2xl scale-[1.03]' : 'bg-zinc-950 border-zinc-800 text-zinc-500 hover:border-zinc-700'}`}>
                      <p className="text-[13px] font-black uppercase italic group-hover:text-red-400">{voice.label}</p>
                      <p className="text-[10px] font-bold opacity-30 mt-3 uppercase tracking-tighter">{voice.description}</p>
                    </button>
                  ))}
                </div>
              </div>
            </aside>
            {/* PANEL DE ADMINISTRACIÓN */}
            <aside className="lg:col-span-3 space-y-6">
              <div className="bg-zinc-900 border border-zinc-800 p-10 rounded-[2.5rem] shadow-2xl sticky top-28">
                <h3 className="text-red-600 font-black text-[13px] uppercase tracking-[0.4em] mb-10 border-b border-zinc-800 pb-5 italic">
                  Administración
                </h3>
                <div className="space-y-5">

                  {/* Sistema de Puntuación */}
                  <div className="p-6 bg-zinc-950 rounded-2xl border border-zinc-800 space-y-3">
                    <p className="text-[10px] font-black uppercase tracking-widest text-zinc-500">Sistema de Puntuación</p>
                    <div className="flex gap-3">
                      <button
                        onClick={() => {
                          setScoringSystem(1);
                          try { localStorage.setItem('palporro_scoring_system', '1'); } catch(e) {}
                        }}
                        className={`flex-1 py-3 rounded-xl font-black text-xs uppercase transition-all ${
                          scoringSystem === 1
                            ? 'bg-red-600 text-white shadow-lg shadow-red-900/40'
                            : 'bg-zinc-800 text-zinc-500 hover:bg-zinc-700'
                        }`}
                      >
                        Sistema 1
                      </button>
                      <button
                        onClick={() => {
                          setScoringSystem(2);
                          try { localStorage.setItem('palporro_scoring_system', '2'); } catch(e) {}
                        }}
                        className={`flex-1 py-3 rounded-xl font-black text-xs uppercase transition-all ${
                          scoringSystem === 2
                            ? 'bg-red-600 text-white shadow-lg shadow-red-900/40'
                            : 'bg-zinc-800 text-zinc-500 hover:bg-zinc-700'
                        }`}
                      >
                        Sistema 2
                      </button>
                    </div>
                    <p className="text-[10px] text-zinc-600 leading-relaxed">
                      {scoringSystem === 1
                        ? 'S1: Lineal. Último=1pt, +1 por posición. Bonus vuelta rápida al acumular 2 o 4.'
                        : 'S2: P1=floor(N×1.5)pt, resto lineal hasta 1. Bonus vuelta rápida al acumular 2 o 4.'}
                    </p>
                  </div>

                  {/* Re-randomizar pista */}
                  <div className="p-6 bg-zinc-950 rounded-2xl border border-zinc-800 space-y-3">
                    <p className="text-[10px] font-black uppercase tracking-widest text-zinc-500">Próxima Pista</p>
                    <p className="text-[11px] text-zinc-400 font-bold">
                      {(nextTrackIndex !== -1 && tracks[nextTrackIndex]) ? tracks[nextTrackIndex].name : 'Pendiente de votación'}
                    </p>
                    <button
                      onClick={async () => {
                        const environment = getEnvironment();
                        // Limpiar AMBOS: Supabase Y localStorage, antes de randomizar
                        // De lo contrario pickRandomNextTrack lee el localStorage y devuelve la misma pista
                        await pinNextTrack(null, environment);
                        localStorage.removeItem('palporro_next_track');
                        const chosenIdx = pickRandomNextTrack(tracks, raceHistory);
                        const chosenName = tracks[chosenIdx]?.name;
                        if (chosenName) {
                          await pinNextTrack(chosenName, environment);
                          setNextTrackIndex(chosenIdx);
                        }
                      }}
                      className="w-full py-3 rounded-xl font-black text-xs uppercase bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-white transition-all"
                    >
                      🎲 Re-randomizar
                    </button>
                  </div>

                </div>
              </div>
            </aside>
            <section className="lg:col-span-6 bg-zinc-900 border border-zinc-800 rounded-[3rem] p-10 shadow-2xl">
              <div className="mb-8 border-b border-zinc-800 pb-6">
                <h2 className="text-[13px] font-black uppercase tracking-[0.3em] text-zinc-400 flex items-center gap-3 italic mb-2">
                  <div className="w-4 h-4 bg-red-600/20 border border-red-600 rotate-45"></div>
                  Estudio de Locución
                </h2>
              </div>

              {/* Emisión directa de texto */}
              <div className="p-6 bg-zinc-950/60 border-2 border-zinc-700 rounded-2xl space-y-4">
                <label className="text-[10px] font-black uppercase text-zinc-500 tracking-widest block">
                  Emitir Texto Directo
                </label>
                <textarea
                  value={directText}
                  onChange={(e) => setDirectText(e.target.value)}
                  placeholder="Escribí el texto exacto que querés emitir..."
                  className="w-full bg-zinc-900 border-2 border-zinc-800 rounded-xl p-5 text-zinc-100 font-bold text-[13px] leading-relaxed focus:outline-none focus:border-red-600 transition-all min-h-[100px] resize-none"
                />
                <button
                  onClick={() => {
                    if (!directText.trim()) return;
                    // Inyectar directamente como script activo
                    const idx = scripts.length;
                    setScripts(prev => [...prev, directText.trim()]);
                    setActiveScriptIdx(idx);
                  }}
                  disabled={!directText.trim()}
                  className="w-full bg-zinc-700 hover:bg-zinc-600 disabled:opacity-30 text-white font-black py-4 rounded-xl uppercase text-[11px] tracking-widest transition-all flex items-center justify-center gap-3"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                  Cargar como Guion
                </button>
              </div>

              <div className="border-t border-zinc-800 pt-2">
                <p className="text-[9px] font-black uppercase text-zinc-700 tracking-widest text-center">— o generá con IA —</p>
              </div>

              <div className="space-y-8">
                {/* Input para prompt personalizado */}
                <div>
                  <label className="text-[10px] font-black uppercase text-zinc-600 tracking-widest mb-4 block">Tema del Spot</label>
                  <textarea
                    value={customPrompt}
                    onChange={(e) => setCustomPrompt(e.target.value)}
                    placeholder="Ej: Mencionar la próxima carrera en Monza, destacar el liderazgo de Slayer..."
                    className="w-full bg-zinc-950 border-2 border-zinc-800 rounded-2xl p-6 text-zinc-100 font-bold text-[13px] leading-relaxed focus:outline-none focus:border-red-600 transition-all min-h-[120px] resize-none"
                  />
                </div>

                {/* Botón generar scripts */}
                <button onClick={handleGenerateScripts} disabled={isGenerating} className="w-full bg-red-600 text-white font-black py-7 rounded-2xl uppercase text-[12px] tracking-widest hover:bg-red-700 transition-all shadow-xl disabled:opacity-20 flex items-center justify-center gap-4 border-b-4 border-red-900">

                  {isGenerating ? <div className="animate-spin h-6 w-6 border-4 border-white border-t-transparent rounded-full" /> : <><svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>Generar Guiones</>}
                </button>

                {/* Navegación de scripts */}
                {scripts.length > 0 && (
                  <div className="flex gap-4 items-center justify-between p-6 bg-zinc-950/40 border border-zinc-800 rounded-2xl">
                    <button onClick={() => setActiveScriptIdx(Math.max(0, activeScriptIdx - 1))} disabled={activeScriptIdx === 0} className="p-4 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-20 rounded-xl transition-all">
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M15 19l-7-7 7-7" /></svg>
                    </button>
                    <span className="text-[11px] font-black uppercase tracking-widest text-zinc-500">Guion {activeScriptIdx + 1} de {scripts.length}</span>
                    <button onClick={() => setActiveScriptIdx(Math.min(scripts.length - 1, activeScriptIdx + 1))} disabled={activeScriptIdx === scripts.length - 1} className="p-4 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-20 rounded-xl transition-all">
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M9 5l7 7-7 7" /></svg>
                    </button>
                  </div>
                )}

                {/* Script actual - AHORA EDITABLE */}
                {scripts[activeScriptIdx] && (
                  <div>
                    <label className="text-[10px] font-black uppercase text-zinc-600 tracking-widest mb-4 block">Guion Generado (Editable)</label>
                    <textarea
                      value={scripts[activeScriptIdx]}
                      onChange={(e) => {
                        const newScripts = [...scripts];
                        newScripts[activeScriptIdx] = e.target.value;
                        setScripts(newScripts);
                      }}
                      className="w-full bg-zinc-950/60 border-2 border-zinc-800 rounded-2xl p-8 text-zinc-300 font-bold text-[15px] italic leading-loose focus:outline-none focus:border-red-600 transition-all min-h-[150px] resize-none"
                    />
                  </div>
                )}

                {/* Botón reproducir */}
                <div className="flex gap-4">
                  {downloadUrl ? (
                    <>
                      {/* Ya hay audio generado: reproducir sin regenerar */}
                      <button
                        onClick={() => {
                          if (playbackAudioRef.current) {
                            playbackAudioRef.current.pause();
                            playbackAudioRef.current.currentTime = 0;
                          }
                          const audio = new Audio(downloadUrl);
                          playbackAudioRef.current = audio;
                          audio.play();
                        }}
                        className="flex-1 bg-zinc-700 text-white font-black py-6 rounded-2xl uppercase text-[12px] tracking-widest hover:bg-zinc-600 transition-all shadow-xl flex items-center justify-center gap-4 border-b-4 border-zinc-900"
                      >
                        <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                        Escuchar de nuevo
                      </button>
                      <button
                        onClick={handlePlayTTS}
                        disabled={isPlayingTTS || !scripts[activeScriptIdx]}
                        className="flex-1 bg-red-600 text-white font-black py-6 rounded-2xl uppercase text-[12px] tracking-widest hover:bg-red-700 transition-all shadow-xl disabled:opacity-20 flex items-center justify-center gap-4 border-b-4 border-red-900"
                      >
                        {isPlayingTTS ? <div className="animate-spin h-6 w-6 border-4 border-white border-t-transparent rounded-full" /> : <><svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>Regenerar</>}
                      </button>
                    </>
                  ) : (
                    <button onClick={handlePlayTTS} disabled={isPlayingTTS || !scripts[activeScriptIdx]} className="flex-1 bg-red-600 text-white font-black py-6 rounded-2xl uppercase text-[12px] tracking-widest hover:bg-red-700 transition-all shadow-xl disabled:opacity-20 flex items-center justify-center gap-4 border-b-4 border-red-900">
                      {isPlayingTTS ? <div className="animate-spin h-6 w-6 border-4 border-white border-t-transparent rounded-full" /> : <><svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>Reproducir Emisión</>}
                    </button>
                  )}
                </div>

                {/* Botones de confirmar y descargar */}
                {downloadUrl && (
                  <div className="flex gap-4 p-6 bg-green-950/20 border border-green-600/30 rounded-2xl">
                    <button onClick={handleConfirmEmission} className="flex-1 bg-green-600 text-white font-black py-5 rounded-xl uppercase text-[11px] tracking-widest hover:bg-green-700 transition-all flex items-center justify-center gap-3">
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M5 13l4 4L19 7" /></svg>
                      Confirmar y Guardar
                    </button>
                    <a href={downloadUrl} download={`palporro-radio-${Date.now()}.wav`} className="flex-1 bg-zinc-100 text-zinc-950 font-black py-5 rounded-xl uppercase text-[11px] tracking-widest hover:bg-white transition-all flex items-center justify-center gap-3">
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                      Descargar Emisión
                    </a>
                  </div>
                )}
              </div>
            </section>

            <aside className="lg:col-span-3">
              <div className="bg-red-950/10 border border-red-900/10 p-12 rounded-[3rem] shadow-2xl h-full flex flex-col justify-center">
                <p className="text-[14px] font-black text-red-500 uppercase tracking-[0.4em] mb-8 italic">Manual</p>
                <p className="text-[12px] text-zinc-400 font-bold leading-loose uppercase italic tracking-tight">"En Palporro Racing, el silencio es para los perdedores. La radio inmortaliza la ineptitud en pista."</p>
              </div>
            </aside>
          </div>
        )}
      </main>

      {/* FOOTER - DISEÑO DEPORTIVO MEJORADO */}
      <footer className="w-full mt-20 md:mt-40 border-t-2 border-zinc-800/50 pt-12 md:pt-24 pb-20 md:pb-32 flex flex-col md:flex-row justify-between items-center px-4 md:px-10 lg:px-32 gap-8 md:gap-16 bg-gradient-to-b from-transparent to-zinc-950/30">
        <div className="flex gap-6 md:gap-10 items-center">
          {/* Logo más grande */}
          <div className="relative w-24 h-24 md:w-32 md:h-32 flex items-center justify-center group">
            <img 
              src="/Logo.jpg" 
              alt="Palporro Racing Logo" 
              className="w-full h-full object-contain opacity-70 group-hover:opacity-100 group-hover:scale-110 transition-all duration-500 drop-shadow-[0_0_25px_rgba(220,38,38,0.5)]" 
            />
          </div>
          
          {/* Desarrollado por NeuraSur - Estilo Racing */}
          <a
            href="https://neurasur.nextba.com"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Desarrollado por NeuraSur"
            className="flex items-center gap-4 group"
          >
            <img 
              src="/GTR34.png" 
              alt="NeuraSur" 
              className="w-12 h-12 md:w-16 md:h-16 rounded-full object-cover flex-shrink-0 shadow-[0_6px_24px_rgba(220,38,38,0.3)] group-hover:shadow-[0_8px_32px_rgba(220,38,38,0.5)] transition-all duration-300 ring-2 ring-red-600/20 group-hover:ring-red-600/40" 
            />
            <div className="flex flex-col gap-1">
              <span className="text-[9px] md:text-[11px] text-zinc-600 uppercase tracking-[0.2em] font-black">
                Powered by
              </span>
              <span 
                className="text-red-500 text-base md:text-xl font-black uppercase tracking-[0.15em] group-hover:text-red-400 transition-all duration-300"
                style={{ fontFamily: 'Impact, "Arial Black", sans-serif', letterSpacing: '0.15em' }}
              >
                NEURASUR
              </span>
            </div>
          </a>
        </div>
        
        {/* Lado derecho - Leyenda y contador */}
        <div className="flex flex-col gap-4 md:gap-6 items-center md:items-end">
          {/* Leyenda más grande */}
          <div 
            className="text-red-600/80 font-black italic tracking-tight text-center md:text-right leading-relaxed hover:text-red-500 transition-colors duration-500 text-sm md:text-lg"
            style={{ fontFamily: 'Impact, "Arial Black", sans-serif' }}
          >
            "EL DRAGÓN REINA EN 2026.<br/>LA VELOCIDAD ES RESPETO.<br/>EL FIASCORE ES LEY."
          </div>
          
          {/* Contador de visitas más destacado */}
          {visitCount !== null && (
            <div className="flex items-center gap-3 bg-zinc-900/50 px-4 py-2 rounded-xl border border-zinc-800/50 backdrop-blur-sm">
              <svg className="w-5 h-5 md:w-6 md:h-6 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
              <span className="text-sm md:text-base font-black text-zinc-300 tabular-nums">{visitCount.toLocaleString()}</span>
              <span className="text-xs md:text-sm text-zinc-500 uppercase tracking-wider font-bold">visitas</span>
            </div>
          )}
        </div>
      </footer>

      {/* MODAL DE ARCHIVO */}
      {showHistoryModal && (
        <div className="fixed inset-0 z-[100] bg-black/90 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-zinc-900 border-2 border-zinc-800 rounded-[3rem] w-full max-w-2xl overflow-hidden shadow-2xl">
            <div className="bg-zinc-800 p-8 border-b border-zinc-700 flex justify-between items-center">
              <h2 className="text-2xl font-black uppercase text-white">Archivo de Emisiones</h2>
              <button onClick={() => setShowHistoryModal(false)} className="p-4 hover:bg-red-600 transition-colors rounded-2xl group">
                <svg className="w-6 h-6 text-zinc-500 group-hover:text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="p-8 space-y-8">
              {/* Mostrar la primera emisión de forma destacada (usa displayedHistory para incluir la por defecto) */}
              {(() => {
                const first = displayedHistory[0];
                const hasReal = emissionHistory.length > 0;
                return (
                  <div className="bg-zinc-950 p-6 md:p-8 rounded-2xl border border-zinc-800 flex flex-col md:flex-row items-start gap-6">
                    <div className="flex-1">
                      <div className="flex items-center justify-between">
                        <div className="font-black uppercase text-lg">{first.voice} { !hasReal && <span className="ml-2 text-xs text-zinc-400 font-normal">(Emisión por defecto)</span> }</div>
                        <div className="text-[10px] text-zinc-500">{new Date(first.timestamp).toLocaleString('es-AR')}</div>
                      </div>
                      <div className="text-zinc-300 italic mt-3 text-sm script-hidden">"Guion disponible"</div>
                      <audio controls src={first.audioUrl} className="w-full mt-4 rounded-lg" />
                    </div>

                    <div className="flex flex-col gap-3 md:gap-4 md:w-40">
                      <a href={first.audioUrl} download={`palporro-${first.id}.wav`} className="px-4 py-3 bg-zinc-800 rounded uppercase text-[11px] font-black text-center">Descargar</a>
                      {hasReal ? (
                        <button onClick={() => handleDeleteEmission(first.id)} className="px-4 py-3 bg-red-700 rounded uppercase text-[11px] font-black">Borrar</button>
                      ) : (
                        <button disabled className="px-4 py-3 bg-zinc-700 rounded uppercase text-[11px] font-black opacity-60">No editable</button>
                      )}
                    </div>
                  </div>
                );
              })()}

              {/* Si hay más emisiones reales, listarlas debajo */}
              {emissionHistory.length > 1 && (
                <div className="space-y-4">
                  {emissionHistory.slice(1).map(e => (
                    <div key={e.id} className="bg-zinc-950 p-4 rounded-2xl border border-zinc-800 flex items-start gap-4">
                      <div className="flex-1">
                        <div className="flex items-center justify-between">
                         <div className="font-black uppercase">{getArtisticName(e.voice)}</div>
                          <div className="text-[10px] text-zinc-500">{new Date(e.timestamp).toLocaleString('es-AR')}</div>
                        </div>
                        <div className="text-zinc-300 italic mt-2 script-hidden">"Guion disponible"</div>
                        <audio controls src={e.audioUrl} className="w-full mt-3" />
                      </div>
                      <div className="flex flex-col gap-2">
                        <a href={e.audioUrl} download={`palporro-${e.id}.wav`} className="px-3 py-2 bg-zinc-800 rounded uppercase text-[10px] font-black">Descargar</a>
                        <button onClick={() => handleDeleteEmission(e.id)} className="px-3 py-2 bg-red-700 rounded uppercase text-[10px] font-black">Borrar</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {/* MODAL DE RESULTADOS DE CARRERA */}
      {showResultsModal && (
  <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/90 backdrop-blur-md p-4">
    <div className="bg-zinc-900 border border-zinc-800 w-full max-w-4xl max-h-[90vh] overflow-y-auto rounded-3xl shadow-2xl relative">
      {/* Botón Cerrar */}
      <button 
        onClick={() => { setShowResultsModal(false); setIsEditingResults(false); setEditingResults(null); }}
        className="absolute top-4 right-4 text-white text-2xl"
      >✕</button>

      {selectedHistoryRace ? (
        <div className="p-8">
            {/* Header con imagen del circuito */}
            <div className="flex items-start justify-between mb-8 gap-6">
              <div className="flex-1">
                <div className="flex items-center gap-4 mb-2">
                  <h2 className="text-4xl font-black uppercase italic tracking-tight">{selectedHistoryRace.track_name}</h2>
                  {selectedHistoryRace.track_name && selectedHistoryRace.track_name.toLowerCase() !== 'training' && (
                    <div className="relative w-24 h-24 bg-zinc-800/50 rounded-xl border border-zinc-700 overflow-hidden group">
                      <img 
                        src={`/tracks/${selectedHistoryRace.track_name.toLowerCase().replace(/\s+/g, '-')}.png`}
                        alt={`${selectedHistoryRace.track_name} layout`}
                        className="w-full h-full object-contain p-2 opacity-70 group-hover:opacity-100 transition-opacity"
                        onError={(e) => {
                          // Si no se encuentra la imagen, mostrar placeholder
                          (e.target as HTMLImageElement).src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="rgb(113,113,122)" stroke-width="2"><path d="M3 12h18M3 12l6 6m-6-6l6-6m12 6l-6 6m6-6l-6-6"/></svg>';
                        }}
                      />
                    </div>
                  )}
                </div>
                <div className="text-xs text-zinc-400 mt-2">{selectedHistoryRace.scheduled_day} • {selectedHistoryRace.scheduled_time}</div>
                {selectedHistoryRace.session_info && (
                  <div className="text-[11px] text-zinc-500 mt-3 flex gap-4">
                    {selectedHistoryRace.session_info.formato && (
                      <span className="bg-zinc-800/50 px-3 py-1 rounded-lg">📋 {selectedHistoryRace.session_info.formato}</span>
                    )}
                    {selectedHistoryRace.session_info.vehicle && (
                      <span className="bg-zinc-800/50 px-3 py-1 rounded-lg">🏎️ {selectedHistoryRace.session_info.vehicle}</span>
                    )}
                  </div>
                )}
              </div>
              <div className="flex gap-2 items-start">
                {!isEditingResults && selectedHistoryRace.id && (
                  <button
                    onClick={async () => {
                      try {
                        const env = (selectedHistoryRace as any).environment || getEnvironment();
                        console.log('🔄 Refrescando datos de carrera desde Supabase...');
                        const fresh = await getRaceById(selectedHistoryRace.id, env as any);
                        if (fresh) {
                          console.log('✅ Datos refrescados:', {
                            hasRelevantData: !!fresh.relevant_data,
                            hasSessionInfo: !!fresh.session_info,
                            relevantData: fresh.relevant_data
                          });
                          setSelectedHistoryRace(fresh);
                          // También actualizar en raceHistory
                          setRaceHistory(prev => prev.map(r => r.id === fresh.id ? fresh : r));
                        } else {
                          alert('No se pudieron recargar los datos');
                        }
                      } catch (err) {
                        console.error('Error refrescando datos:', err);
                        alert('Error al recargar los datos');
                      }
                    }}
                    className="bg-blue-600 hover:bg-blue-700 text-white font-black py-2 px-3 rounded-xl text-sm transition-all"
                    title="Refrescar datos desde Supabase"
                  >
                    🔄
                  </button>
                )}
                {!isEditingResults && (
                  <button
                    onClick={() => {
                      const code = prompt('Ingresá el código RADIO para editar:');
                      if (code === RADIO_CODE) {
                        const results = selectedHistoryRace.race_results || [];
                        const initialResults = results.length > 0 
                          ? JSON.parse(JSON.stringify(results))
                          : [{ pilot: '', position: 1, totalTime: '', bestLap: '', isWinner: false }];
                        setEditingResults(initialResults);
                        setSessionInfo(selectedHistoryRace.session_info || null);
                        setRelevantData(selectedHistoryRace.relevant_data || null);
                        setIsEditingResults(true);
                      } else if (code !== null) {
                        alert('Código incorrecto');
                      }
                    }}
                    className="bg-zinc-800 hover:bg-zinc-700 text-white font-black py-2 px-4 rounded-xl text-sm transition-all"
                  >
                    ✏️ Editar
                  </button>
                )}
                {isEditingResults && (
                  <>
                    <button
                      onClick={async () => {
                        if (!editingResults) return;
                        setIsSavingResults(true);

                        const finalResults = editingResults.map((r) => ({ ...r }));
                        const env = getEnvironment() as any;

                        // ¿La carrera YA tenía resultados antes de este guardado?
                        // Si tenía, es una edición/corrección → no resetear votos.
                        // Si no tenía (race_results vacío o undefined), es la primera
                        // carga de resultados → SÍ resetear votos y avanzar pista.
                        const hadResultsBefore =
                          Array.isArray(selectedHistoryRace.race_results) &&
                          selectedHistoryRace.race_results.length > 0;

                        try {
                          const payloadRelevantData = relevantData || computeRelevantDataFromResults(finalResults);

                          const result = await upsertRaceResults(
                            selectedHistoryRace.track_name,
                            finalResults,
                            env,
                            selectedHistoryRace.id,
                            sessionInfo,
                            payloadRelevantData
                          );

                          if (result.success && result.race) {
                            // Siempre: actualizar standings
                            await updateStandingsFromRace(finalResults);

                            // Siempre: actualizar estado local
                            setRaceHistory(prev => {
                              const existing = prev.find(r => r.id === result.race!.id);
                              return existing
                                ? prev.map(r => r.id === result.race!.id ? result.race! : r)
                                : [result.race!, ...prev];
                            });
                            setSelectedHistoryRace(result.race);
                            setIsEditingResults(false);
                            setEditingResults(null);
                            setSessionInfo(null);
                            setRelevantData(null);

                            // Recargar historial completo
                            const updated = await getRaceHistory(env);
                            if (updated) {
                              setRaceHistory(updated);
                              const freshRace = updated.find(r => r.id === result.race!.id);
                              if (freshRace) setSelectedHistoryRace(freshRace);
                            }

                            // ── Solo si es la PRIMERA vez que se cargan resultados ──
                            if (!hadResultsBefore) {
                              // Mover votos a race_votes y limpiar palporro_votes.
                              // IMPORTANTE: usar getVotes (todos) en lugar de getRelevantVotes,
                              // porque getRelevantVotes filtra por próxima pista y devuelve []
                              // si la pista ya cambió al momento de cargar resultados.
                              try {
                                // Leer votos ANTES de archivarlos/borrarlos
                                const votes = await getVotes(env);
                                console.log('🗳️ Votos a archivar:', votes?.length ?? 0);

                                // Archivar votos en race_votes y limpiar palporro_votes
                                if (Array.isArray(votes) && votes.length > 0) {
                                  const moved = await moveVotesToRace(result.race!.id, votes, env);
                                  if (moved) console.log('✅ Votos archivados en race_votes:', votes.length);
                                  else console.error('❌ moveVotesToRace devolvió false');
                                }

                                // Resetear estado local
                                setVotingState({
                                  isOpen: false,
                                  hasVoted: false,
                                  selectedSlots: [],
                                  selectedDays: [],
                                  selectedTimes: [],
                                  userPilot: votingState.userPilot,
                                  allVotes: []
                                });
                                localStorage.removeItem('palporro_voting');
                                localStorage.removeItem('palporro_next_track');

                                // Resetear pista en Supabase
                                await pinNextTrack(null, env);
                                setNextTrackIndex(-1);
                                console.log('✅ Pista reseteada en Supabase');

                                // La pista se asignará automáticamente cuando llegue
                                // el primer voto nuevo via subscribeToVotes (getPinnedTrack = null → asignar)
                                // No hay votos frescos porque acaban de archivarse — es correcto.
                                console.log('✅ Reset completo. Esperando votos para la siguiente pista.');

                              } catch (e) {
                                console.warn('Error en reset post-resultados:', e);
                              }

                              // Resetear estado de votación local
                              try {

                                // Resetear cutoff al inicio del domingo actual (semana nueva)
                                const now = new Date();
                                const argNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
                                const d = new Date(argNow);
                                d.setDate(d.getDate() - d.getDay()); // retroceder al domingo
                                d.setHours(0, 0, 0, 0);
                                localStorage.setItem('palporro_voting_start', d.toISOString());
                                localStorage.setItem('palporro_last_archive', new Date().toISOString());

                                console.log('✅ Votación reseteada para la próxima pista');
                              } catch (e) {
                                console.warn('Error reseteando votación:', e);
                              }

                              // Notificar con setTimeout para que React repinte ANTES del alert
                              setTimeout(() => alert('✅ Resultados guardados. Standings y votación actualizados para la próxima pista.'), 100);
                            } else {
                              setTimeout(() => alert('✅ Resultados actualizados. Standings recalculados.'), 100);
                            }

                          } else {
                            throw new Error('No se pudo guardar la carrera');
                          }
                        } catch (err) {
                          console.error('Error saving results:', err);
                          setTimeout(() => alert('Error guardando resultados. Revisá la consola para más detalles.'), 100);
                        } finally {
                          setIsSavingResults(false);
                        }
                      }}
                      className="bg-green-600 text-white font-black py-3 px-4 rounded-2xl uppercase text-sm tracking-widest hover:bg-green-700 transition-all shadow-xl flex items-center gap-2"
                    >
                      {isSavingResults ? <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" /> : null}
                      Guardar
                    </button>
                    <button
                      onClick={() => { setIsEditingResults(false); setEditingResults(null); }}
                      className="bg-zinc-800 text-zinc-200 font-black py-3 px-4 rounded-2xl"
                    >
                      Cancelar
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Preview: JSON que se va a guardar (ayuda a identificar qué se graba) */}
            {isEditingResults && editingResults && (
              <div className="p-4 mt-4 bg-zinc-900 border border-zinc-800 rounded-lg">
                <div className="text-[11px] font-black text-zinc-400 mb-2">Preview (JSON) — lo que se grabará:</div>
                <pre className="text-xs bg-zinc-950 p-3 rounded text-zinc-200 overflow-auto max-h-40">{JSON.stringify(editingResults, null, 2)}</pre>
              </div>
            )}

            {/* Herramientas de edición */}
            {isEditingResults && (
              <>
                {/* Botones de herramientas en modo edición */}
                <div className="flex gap-2 mb-4 flex-wrap">
                  <button
                    onClick={() => setShowJsonImport(!showJsonImport)}
                    className="px-4 py-2 bg-blue-600 text-white font-black rounded-xl text-sm hover:bg-blue-700 transition-all"
                  >
                    {showJsonImport ? 'Cerrar' : 'Importar JSON'}
                  </button>
                  <button
                    onClick={() => {
                      setEditingResults(prev => [
                        ...(prev || []),
                        { 
                          pilot: '', 
                          position: (prev?.length || 0) + 1, 
                          totalTime: '', 
                          bestLap: '', 
                          isWinner: false 
                        }
                      ]);
                    }}
                    className="px-4 py-2 bg-green-600 text-white font-black rounded-xl text-sm hover:bg-green-700 transition-all"
                  >
                    + Agregar Piloto
                  </button>
                </div>

                {/* Panel de importación de JSON */}
                {showJsonImport && (
              <div className="mb-6 p-6 bg-zinc-950 border-2 border-blue-600/50 rounded-2xl">
                <h3 className="text-lg font-black uppercase text-blue-400 mb-4">Importar Resultados desde JSON</h3>
                <p className="text-xs text-zinc-400 mb-4">
                  Pegá el JSON con el formato de resultados de carrera. Debe contener un array "clasificacion_completa" con los datos de cada piloto.
                </p>
                <textarea
                  value={jsonInput}
                  onChange={(e) => setJsonInput(e.target.value)}
                  placeholder='{"sesion_info": {...}, "clasificacion_completa": [...]}'
                  className="w-full bg-zinc-900 border border-zinc-700 rounded-xl p-4 text-zinc-100 font-mono text-xs min-h-[200px] focus:outline-none focus:border-blue-500"
                />
                <div className="flex gap-3 mt-4">
                  <button
                    onClick={handleImportJson}
                    className="px-6 py-3 bg-blue-600 text-white font-black rounded-xl hover:bg-blue-700 transition-all"
                  >
                    Importar
                  </button>
                  <button
                    onClick={() => {
                      setShowJsonImport(false);
                      setJsonInput('');
                    }}
                    className="px-6 py-3 bg-zinc-700 text-white font-black rounded-xl hover:bg-zinc-600 transition-all"
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            )}
              </>
            )}

           {/* Render de los resultados (editable si isEditingResults) - MEJORADO */}
           <div className="space-y-3">
             {(isEditingResults ? editingResults || [] : selectedHistoryRace.race_results || []).map((res, idx) => (
               <div key={idx} className={`bg-zinc-800/50 border ${res.isWinner ? 'border-yellow-600/50' : 'border-zinc-700'} p-5 rounded-2xl hover:bg-zinc-800/70 transition-all`}>
                 {isEditingResults ? (
                   // Modo edición
                   <div className="flex flex-col gap-4">
                     <div className="flex items-center gap-3">
                       <input type="number" value={res.position} onChange={(e) => {
                         const val = parseInt(e.target.value || '0', 10);
                         setEditingResults(prev => {
                           if (!prev) return prev;
                           const copy = [...prev];
                           copy[idx] = { ...copy[idx], position: val };
                           return copy;
                         });
                       }} className="w-16 bg-zinc-900 p-2 rounded text-center" />
                       <input value={res.pilot} onChange={(e) => setEditingResults(prev => {
                         if (!prev) return prev;
                         const copy = [...prev];
                         copy[idx] = { ...copy[idx], pilot: e.target.value };
                         return copy;
                       })} className="bg-zinc-900 p-2 rounded flex-1" placeholder="Nombre del piloto" />
                       <button
                         onClick={() => setEditingResults(prev => {
                           if (!prev) return prev;
                           return prev.filter((_, i) => i !== idx);
                         })}
                         className="p-2 bg-red-600 hover:bg-red-700 rounded-lg text-white transition-all"
                         title="Eliminar"
                       >
                         <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                           <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                         </svg>
                       </button>
                     </div>
                     <div className="flex gap-3 flex-wrap">
                       <input value={res.totalTime} onChange={(e) => setEditingResults(prev => {
                         if (!prev) return prev;
                         const copy = [...prev];
                         copy[idx] = { ...copy[idx], totalTime: e.target.value };
                         return copy;
                       })} className="bg-zinc-900 p-2 rounded w-32" placeholder="Tiempo total" />
                       <input value={res.bestLap} onChange={(e) => setEditingResults(prev => {
                         if (!prev) return prev;
                         const copy = [...prev];
                         copy[idx] = { ...copy[idx], bestLap: e.target.value };
                         return copy;
                       })} className="bg-zinc-900 p-2 rounded w-32" placeholder="Mejor vuelta" />
                       <label className="flex items-center gap-2 bg-zinc-900 px-3 py-2 rounded">
                         <input type="checkbox" checked={!!res.isWinner} onChange={(e) => setEditingResults(prev => {
                           if (!prev) return prev;
                           const copy = prev.map((r, i) => ({ ...r, isWinner: i === idx ? e.target.checked : false }));
                           return copy;
                         })} />
                         <span>🏆 Ganador</span>
                       </label>
                       <label className="flex items-center gap-2 bg-zinc-900 px-3 py-2 rounded">
                         <input type="checkbox" checked={!!res.isNoShow} onChange={(e) => setEditingResults(prev => {
                           if (!prev) return prev;
                           const copy = [...prev];
                           copy[idx] = { ...copy[idx], isNoShow: e.target.checked };
                           return copy;
                         })} />
                         <span>❌ No-Show</span>
                       </label>
                     </div>
                   </div>
                 ) : (
                   // Modo visualización MEJORADO
                   <div className="flex flex-col gap-4">
                     {/* Línea 1: Posición y Piloto */}
                     <div className="flex items-center gap-4">
                       <div className={`text-3xl font-black ${res.position === 1 ? 'text-yellow-500' : res.position === 2 ? 'text-zinc-400' : res.position === 3 ? 'text-orange-700' : 'text-zinc-600'} w-12 text-center`}>
                         {res.position}
                       </div>
                       <div className="flex-1">
                         <div className="text-xl font-black text-white uppercase tracking-wide flex items-center gap-3">
                           {res.pilot}
                           {res.isWinner && <span className="text-2xl">🏆</span>}
                           {res.isNoShow && <span className="text-red-400 text-sm font-bold">❌ NO SHOW</span>}
                         </div>
                       </div>
                     </div>

                     {/* Línea 2: Tiempos principales */}
                     <div className="grid grid-cols-2 md:grid-cols-3 gap-4 bg-zinc-900/50 p-4 rounded-xl">
                       <div>
                         <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Tiempo Total</div>
                         <div className="text-lg font-mono font-black text-red-400">{res.totalTime || 'N/A'}</div>
                       </div>
                       <div>
                         <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Mejor Vuelta</div>
                         <div className="text-lg font-mono font-black text-green-400">{res.bestLap || 'N/A'}</div>
                       </div>
                       {res.laps && (
                         <div>
                           <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Vueltas</div>
                           <div className="text-lg font-mono font-black text-blue-400">{res.laps}</div>
                         </div>
                       )}
                     </div>

                     {/* Línea 3: Sectores */}
                     {res.bestSectors && (res.bestSectors.S1 || res.bestSectors.S2 || res.bestSectors.S3) && (
                       <div className="grid grid-cols-3 gap-3">
                         {res.bestSectors.S1 && (
                           <div className="bg-purple-900/20 border border-purple-600/30 p-3 rounded-lg">
                             <div className="text-[9px] text-purple-400 uppercase tracking-wider mb-1">Sector 1</div>
                             <div className="text-sm font-mono font-bold text-purple-300">{res.bestSectors.S1}</div>
                           </div>
                         )}
                         {res.bestSectors.S2 && (
                           <div className="bg-blue-900/20 border border-blue-600/30 p-3 rounded-lg">
                             <div className="text-[9px] text-blue-400 uppercase tracking-wider mb-1">Sector 2</div>
                             <div className="text-sm font-mono font-bold text-blue-300">{res.bestSectors.S2}</div>
                           </div>
                         )}
                         {res.bestSectors.S3 && (
                           <div className="bg-green-900/20 border border-green-600/30 p-3 rounded-lg">
                             <div className="text-[9px] text-green-400 uppercase tracking-wider mb-1">Sector 3</div>
                             <div className="text-sm font-mono font-bold text-green-300">{res.bestSectors.S3}</div>
                           </div>
                         )}
                       </div>
                     )}

                     {/* Línea 4: Info adicional */}
                     {(res.incidents !== undefined || res.status) && (
                       <div className="flex gap-4 text-xs text-zinc-500">
                         {res.incidents !== undefined && (
                           <span className="bg-red-900/20 px-3 py-1 rounded-lg">⚠️ Incidentes: {res.incidents}</span>
                         )}
                         {res.status && (
                           <span className="bg-zinc-800 px-3 py-1 rounded-lg">{res.status}</span>
                         )}
                       </div>
                     )}
                   </div>
                 )}
               </div>
             ))}
             
             {/* Mensaje si no hay resultados */}
             {!isEditingResults && (!selectedHistoryRace.race_results || selectedHistoryRace.race_results.length === 0) && (
               <div className="p-10 text-center bg-zinc-950/50 rounded-2xl border-2 border-dashed border-zinc-800">
                 <svg className="w-12 h-12 mx-auto mb-4 text-zinc-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                   <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
                 </svg>
                 <p className="font-black uppercase tracking-[0.4em] text-[10px] text-zinc-700 italic">
                   No hay resultados cargados para esta carrera
                 </p>
                 <p className="text-xs text-zinc-600 mt-2">
                   Hacé click en "✏️ Editar" para agregar datos
                 </p>
               </div>
             )}
           </div>

           {/* Datos Relevantes de la Carrera */}
           {!isEditingResults && selectedHistoryRace.relevant_data && (() => {
             // Normalizar relevant_data a strings seguros ANTES de renderizar
             const rd = selectedHistoryRace.relevant_data;
             const toStr = (v: any): string => {
              if (v === null || v === undefined) return '';
              if (typeof v === 'object' && !Array.isArray(v)) {
                // Formatear objeto como pares clave: valor legibles
                return Object.entries(v)
                  .filter(([, val]) => val !== null && val !== undefined && val !== '')
                  .map(([key, val]) => `${key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}: ${val}`)
                  .join('\n');
              }
              if (Array.isArray(v)) return v.map(item => toStr(item)).join('\n');
              return String(v);
            };
             const rendimiento = toStr(rd.rendimiento || rd.performance);
             const resumen     = toStr(rd.resumen_jornada || rd.summary);
             const SKIP = new Set(['performance', 'summary', 'rendimiento', 'resumen_jornada']);
             const extras = Object.entries(rd)
               .filter(([k, v]) => !SKIP.has(k) && v !== null && v !== undefined && v !== '')
               .map(([k, v]) => ({ key: k, val: toStr(v) }))
               .filter(({ val }) => !!val);
             return (
               <div className="mt-8 space-y-4">
                 <h3 className="text-sm font-black uppercase tracking-wider text-zinc-400 border-b border-zinc-800 pb-2">
                   📊 Análisis de Carrera
                 </h3>
                 {rendimiento && (
                   <div className="bg-zinc-800/50 p-4 rounded-xl">
                     <div className="text-[10px] font-black uppercase tracking-wider text-red-500 mb-2">Rendimiento</div>
                     <p className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap">{rendimiento}</p>
                   </div>
                 )}
                 {resumen && (
                   <div className="bg-zinc-800/50 p-4 rounded-xl">
                     <div className="text-[10px] font-black uppercase tracking-wider text-red-500 mb-2">Resumen</div>
                     <p className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap">{resumen}</p>
                   </div>
                 )}
                 {extras.map(({ key, val }) => (
                   <div key={key} className="bg-zinc-800/50 p-4 rounded-xl">
                     <div className="text-[10px] font-black uppercase tracking-wider text-red-500 mb-2">
                       {key.replace(/_/g, ' ')}
                     </div>
                     <p className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap">{val}</p>
                   </div>
                 ))}
               </div>
             );
           })()}
           {/* Debug para ver si hay relevant_data */}
           {!isEditingResults && !selectedHistoryRace.relevant_data && selectedHistoryRace.race_results && selectedHistoryRace.race_results.length > 0 && (
             <div className="mt-4 p-3 bg-zinc-900/50 rounded text-xs text-zinc-600">
               ℹ️ Esta carrera no tiene datos de análisis guardados
               {console.log('🔍 Debug - selectedHistoryRace completo:', selectedHistoryRace)}
             </div>
           )}
        </div>
      ) : (
        <div className="p-20 text-center">Cargando datos...</div>
      )}
    </div>
  </div>
)}
    </div>
  );
}


export default App;