
import React, { useState, useRef, useMemo, useEffect } from 'react';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleGenAI } from '@google/genai';
import { PILOTS, INITIAL_TRACKS, SCRIPT_SYSTEM_INSTRUCTION_DYNAMIC, VOICE_OPTIONS, ANALYSIS_SYSTEM_INSTRUCTION, ARTISTIC_ALIASES } from './constants';
import { decode, encode, decodeAudioData, createWavBlob } from './audioUtils';
import { TrackStatus, Standing } from './types';
import { getVotes, addVote, subscribeToVotes, getVotingStats, getEnvironment, getVoteByIp, TimeSlot } from "./src/supabaseClient";

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

const VOTING_DAYS = ['Lunes', 'Martes', 'Miércoles', 'Jueves'];
const VOTING_TIMES = ['18:00', '18:30', '19:00', '19:30', '20:00', '20:30', '22:00', '22:30', '23:00'];

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'radio'>('dashboard');
  const [radioAccessCode, setRadioAccessCode] = useState('');
  const [isRadioUnlocked, setIsRadioUnlocked] = useState(false);
  const RADIO_CODE = '1290';
  const geminiKey = import.meta.env.VITE_GEMINI_API_KEY
    || (window as any).__PALPORRO_CONFIG?.VITE_GEMINI_API_KEY
    || '';

  // Agregar estos estados PRIMERO
  const [debugMode, setDebugMode] = useState(false);
  const [forceVotingActive, setForceVotingActive] = useState(false);
  const [useGridVoting, setUseGridVoting] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem('palporro_grid_voting');
      return v == null ? true : v === '1';
    } catch (e) { return true; }
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

  const [tracks] = useState<TrackStatus[]>(INITIAL_TRACKS.map((t, idx) => ({ 
    name: t, 
    completed: idx === 0
  })));
  
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

  // Floating player controls
  const [isFloatingMinimized, setIsFloatingMinimized] = useState(false);

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
    if (forceVotingActive) return true; // Override para testing

    // Use Argentina timezone for voting calculations
    const now = new Date();
    const argNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));

    // Determine voting start (saved in localStorage as ISO string). If missing, compute previous Sunday.
    const stored = localStorage.getItem('palporro_voting_start');
    let start: Date;
    if (stored) {
      const parsed = new Date(stored);
      if (!isNaN(parsed.getTime())) start = parsed;
    }
    if (!start) {
      // compute previous Sunday at 00:00 in Argentina timezone
      const d = new Date(argNow);
      const dow = d.getDay(); // 0..6
      const daysBack = dow; // if Sunday->0, else go back dow days
      d.setDate(d.getDate() - daysBack);
      d.setHours(0,0,0,0);
      start = d;
      // persist for future runs
      try { localStorage.setItem('palporro_voting_start', start.toISOString()); } catch(e){}
    }

    // Active for 7 days starting at 'start'
    const end = new Date(start);
    end.setDate(end.getDate() + 7);

    return argNow >= start && argNow < end;
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
  const nextTrackIndex = useMemo(() => tracks.findIndex(t => !t.completed), [tracks]);

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
    try {
      const genAI = new GoogleGenerativeAI(geminiKey);
      const model = genAI.getGenerativeModel({ 
        model: 'gemini-2.5-flash-lite',
        systemInstruction: ANALYSIS_SYSTEM_INSTRUCTION,
        generationConfig: {
          responseMimeType: "application/json",
        }
      });
      const result = await model.generateContent(`Analizá estos datos: ${metricsInput}`);
      const data = JSON.parse(result.response.text() || '{}');
      setAnalysis(data.summary);
      if (data.standings) setStandings(data.standings);
    } catch (err) {
      console.error(err);
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
      const femaleInstruction = `Habla como una mujer locutora de radio nocturna argentina, especializada en automovilismo. Voz de mujer, tono grave y sedoso; transmití seguridad, experiencia y pasión por los motores. Ritmo acelerado y cadencioso, sensual pero sobrio; sin exageraciones. Usá modismos argentinos suaves y naturales (ej.: \"che\", \"piola\"), sin caricatura.`;
      const maleInstruction = `Actuá como un hombre porteño, con poco conocimiento técnico de autos y mucho cinismo. Tono irónico, humor seco y pausado. Mantené un acento rioplatense leve. Evitá tecnicismos y mostrale al oyente duda y sarcasmo sutil.`;

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
        return `<speak><prosody rate=\"98%\" pitch=\"-0.5st\" volume=\"+0dB\">${escaped.replace(/\n\n/g, '<break time=\"200ms\"/>')}</prosody></speak>`;
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
        source.playbackRate.value = 1.08; 
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

  const handleConfirmEmission = () => {
    if (!downloadUrl || !scripts[activeScriptIdx]) return;
    
    const newEmission = {
      id: Date.now().toString(),
      script: scripts[activeScriptIdx],
      voice: VOICE_OPTIONS.find(v => v.id === selectedVoice)?.label || selectedVoice,
      audioUrl: downloadUrl,
      timestamp: new Date()
    };
    
    const updatedHistory = [newEmission, ...emissionHistory];
    setEmissionHistory(updatedHistory);
    localStorage.setItem('palporro-emissions', JSON.stringify(updatedHistory));
    setDownloadUrl(null);
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
    const voteData: VoteData = {
      slots: votingState.selectedSlots,
      pilot: votingState.userPilot!,
      timestamp: Date.now(),
      ip: undefined
    };

    // Best-effort: fetch public IP first so it's sent with the vote
    try {
      const resp = await fetch('https://api.ipify.org?format=json');
      if (resp.ok) {
        const j = await resp.json();
        voteData.ip = j.ip;
      }
    } catch (e) {
      // ignore failures to obtain IP
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
      ...votingState.allVotes.filter(v => v.pilot !== votingState.userPilot),
      voteData
    ];
    
    const newState = {
      ...votingState,
      hasVoted: true,
      allVotes: updatedVotes
    };

    setVotingState(newState);
    localStorage.setItem('palporro_voting', JSON.stringify(newState));
    setIsSubmittingVote(false);
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
      'Jueves': 4
    };

    const now = new Date();
    const targetDay = dayMap[dayName];
    const currentDay = now.getDay();
  
    let daysUntil = targetDay - currentDay;
    if (daysUntil <= 0) daysUntil += 7;

    const raceDate = new Date(now);
    raceDate.setDate(now.getDate() + daysUntil);

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

  // Clear votes after the confirmed date has passed so pilot tags are removed
  useEffect(() => {
    const checkAndClear = () => {
      const next = getNextRaceInfo();
      if (!next) return;
      // If the scheduled race date/time is in the past, reset voting window and clear votes
      if (next.date.getTime() <= Date.now()) {
        // compute previous Sunday in Argentina timezone
        const now = new Date();
        const argNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
        const d = new Date(argNow);
        const dow = d.getDay();
        d.setDate(d.getDate() - dow);
        d.setHours(0,0,0,0);
        try { localStorage.setItem('palporro_voting_start', d.toISOString()); } catch(e){}

        setVotingState(prev => ({ ...prev, allVotes: [], hasVoted: false, selectedSlots: [], selectedDays: [], selectedTimes: [] }));
        try { localStorage.removeItem('palporro_voting'); } catch(e){}
      }
    };

    checkAndClear();
    const id = setInterval(checkAndClear, 30 * 1000); // check every 30s
    return () => clearInterval(id);
  }, [votingState.allVotes]);

  // Cargar votos al inicio e identificar piloto por IP
  useEffect(() => {
    const environment = getEnvironment();

    const loadVotes = async () => {
      // 1. Obtener IP
      let userIp: string | undefined;
      try {
        const resp = await fetch('https://api.ipify.org?format=json');
        if (resp.ok) {
          const j = await resp.json();
          userIp = j.ip;
        }
      } catch (e) {
        console.warn('No se pudo obtener IP');
      }

      // 2. Cargar todos los votos
      const votes = await getVotes(environment);

      // 3. Si tenemos IP, buscar si ya votó desde esta IP
      if (userIp) {
        const existingVote = votes.find(v => v.ip === userIp);
        if (existingVote) {
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
    };

    loadVotes();

    // Suscribirse a cambios en tiempo real
    const unsubscribe = subscribeToVotes(environment, async (votes) => {
      setVotingState(prev => ({ ...prev, allVotes: votes }));
      const dayCount: Record<string, number> = {};
      const timeCount: Record<string, number> = {};
      votes.forEach((v: any) => (v.slots || []).forEach((s: any) => { dayCount[s.day] = (dayCount[s.day] || 0) + 1; timeCount[s.time] = (timeCount[s.time] || 0) + 1; }));
      setVotingStats({ totalVotes: votes.length, dayCount, timeCount });
    });

    return () => unsubscribe();
  }, []);

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
            <button onClick={() => setActiveTab('dashboard')} className={`px-2 md:px-4 lg:px-6 py-1.5 md:py-2.5 text-[8px] md:text-[10px] font-black uppercase transition-all rounded-lg ${activeTab === 'dashboard' ? 'bg-zinc-100 text-zinc-950 shadow-xl' : 'text-zinc-500'}`}>
              PORTADA
            </button>
            <button onClick={() => setActiveTab('radio')} className={`px-2 md:px-4 lg:px-6 py-1.5 md:py-2.5 text-[8px] md:text-[10px] font-black uppercase transition-all rounded-lg ${activeTab === 'radio' ? 'bg-zinc-100 text-zinc-950 shadow-xl' : 'text-zinc-500'}`}>
              RADIO
            </button>
            <button onClick={() => setShowHistoryModal(true)} className="hidden sm:flex px-2 md:px-4 lg:px-6 py-1.5 md:py-2.5 text-[8px] md:text-[10px] font-black uppercase transition-all rounded-lg text-zinc-500 hover:text-red-600 items-center gap-1 md:gap-2">
              <svg className="w-3 h-3 md:w-4 md:h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
              </svg>
              ARCHIVO ({displayedHistory.length})
            </button>
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

      {/* VERSIÓN MÓVIL DEL REPRODUCTOR - Fijo en la parte inferior */}
      {activeTab === 'dashboard' && (
        <div className="fixed bottom-0 left-0 right-0 z-50 md:hidden bg-zinc-900 border-t-2 border-red-600/50 shadow-[0_-10px_60px_rgba(220,38,38,0.4)] backdrop-blur-xl bg-opacity-95 p-4 safe-area-inset-bottom">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
              <span className="w-2 h-2 rounded-full bg-red-600 animate-pulse"></span>
              <span className="text-[9px] font-black uppercase tracking-widest text-red-600">Última Emisión</span>
            </div>
            <button 
              onClick={() => setShowHistoryModal(true)} 
              className="p-2 hover:bg-red-600/20 rounded-lg transition-colors"
              title="Ver Archivo"
            >
              <svg className="w-4 h-4 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
              </svg>
            </button>
          </div>
          <audio controls className="w-full" preload="auto">
            <source src={displayedHistory[0].audioUrl} type="audio/wav" />
            Tu navegador no soporta audio.
          </audio>
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

      {/* PANEL DE VOTACIÓN LATERAL */}
      {isVotingActive() && (
        <>
          {/* Solapa para abrir/cerrar */}
          <button
            onClick={() => setVotingState(prev => ({ ...prev, isOpen: !prev.isOpen }))}
            className={`fixed right-0 top-1/2 -translate-y-1/2 z-[60] ${
              !votingState.hasVoted ? 'bg-red-700 text-white shadow-2xl border-red-700 animate-pulse' : 'bg-zinc-900 border-zinc-700'
            } rounded-l-2xl p-3 md:p-4 transition-all hover:pr-4 md:hover:pr-6 group`}
            style={{ writingMode: 'vertical-rl' }}
            title="Abrir panel de votación"
          >
            <div className="flex items-center gap-2 md:gap-3">
              {!votingState.hasVoted && (
                <span className="w-2 h-2 md:w-3 md:h-3 bg-red-600 rounded-full animate-ping"></span>
              )}
              <span className={`font-black uppercase tracking-widest text-xs md:text-sm ${
                !votingState.hasVoted ? 'text-white' : 'text-zinc-400'
              } group-hover:text-red-500`}>
                VOTACIÓN Próxima Fecha
              </span>
            </div>
          </button>

          {/* Mobile voting quick access (shows text 'Próxima Fecha' on small screens) */}
          <button
            onClick={() => setVotingState(prev => ({ ...prev, isOpen: !prev.isOpen }))}
            className={`md:hidden fixed right-4 bottom-24 z-[70] px-4 py-3 rounded-2xl font-black text-sm tracking-widest flex items-center gap-3 ${
              !votingState.hasVoted ? 'bg-red-600 text-white shadow-2xl animate-pulse' : 'bg-zinc-800 text-zinc-100'
            }`}
          >
            <span>VOTÁ</span>
            <span className="text-[11px] opacity-80">• Próxima Fecha</span>
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
                disabled={isSubmittingVote}
                className={`w-full p-4 font-black rounded-lg uppercase text-sm tracking-widest transition-all disabled:opacity-60 ${
                  pendingVoteChange ? 'bg-red-700 text-white hover:bg-red-800' : (votingState.hasVoted ? 'bg-zinc-700 text-zinc-300 cursor-default' : 'bg-red-600 text-white hover:bg-red-700')
                }`}
              >
                {pendingVoteChange ? 'Confirmar cambios' : (votingState.hasVoted ? 'Votaste! Gracias' : 'Votar!')}
              </button>
            </div>
          </div>
        </>
      )}

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
            <div className="divide-y divide-zinc-800/50">
              {(votingState.allVotes ?? []).map(vote => {
                const days = (vote as any).days ?? ((vote as any).slots ? (vote as any).slots.map((s: any) => s.day) : []);
                const times = (vote as any).times ?? ((vote as any).slots ? (vote as any).slots.map((s: any) => s.time) : []);
                return (
                  <div key={vote.pilot} className="px-4 py-3 flex flex-col gap-1.5">
                    <span className="text-[11px] font-black uppercase text-zinc-200">
                      {vote.pilot}
                    </span>
                    <div className="flex flex-wrap gap-1">
                      {(days ?? []).map((day: string) => (
                        <span key={day} className="text-[9px] font-black px-2 py-0.5 rounded-full bg-red-600/20 text-red-400 border border-red-600/30">
                          {day}
                        </span>
                      ))}
                      {(times ?? []).map((time: string) => (
                        <span key={time} className="text-[9px] font-black px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-400 border border-zinc-700">
                          {time}hs
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
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
              <div className="divide-y divide-zinc-800/50">
                {(votingState.allVotes ?? []).map(vote => {
                  const days = (vote as any).days ?? ((vote as any).slots ? (vote as any).slots.map((s: any) => s.day) : []);
                  const times = (vote as any).times ?? ((vote as any).slots ? (vote as any).slots.map((s: any) => s.time) : []);
                  return (
                    <div key={vote.pilot} className="px-4 py-3 flex flex-col gap-1.5">
                      <span className="text-[11px] font-black uppercase text-zinc-200">
                        {vote.pilot}
                      </span>
                      <div className="flex flex-wrap gap-1">
                        {(days ?? []).map((day: string) => (
                          <span key={day} className="text-[9px] font-black px-2 py-0.5 rounded-full bg-orange-600/20 text-orange-400 border border-orange-600/30">
                            {day}
                          </span>
                        ))}
                        {(times ?? []).map((time: string) => (
                          <span key={time} className="text-[9px] font-black px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-400 border border-zinc-700">
                            {time}hs
                          </span>
                        ))}
                      </div>
                    </div>
                  );
                })}
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
                  {tracks.map((t, idx) => {
                    const isNext = idx === nextTrackIndex;
                    const isTraining = idx === 0;
                    return (
                      <button key={t.name} onClick={() => setSelectedTrack(t.name)} className={`w-full p-4 rounded-xl border transition-all flex items-center justify-between relative overflow-hidden group ${t.completed ? 'bg-zinc-800/20 border-zinc-700 hover:border-red-600/40' : isNext ? 'bg-zinc-900 border-red-600/50 shadow-xl' : 'bg-zinc-950 border-zinc-800 hover:border-zinc-600'}`}>
                        {isNext && <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-red-600 shadow-[2px_0_15px_rgba(220,38,38,1)]"></div>}
                        <div className="flex items-center gap-5">
                            <span className={`text-[11px] font-mono font-black ${t.completed ? 'text-zinc-500' : isNext ? 'text-red-600' : 'text-zinc-700'}`}>{idx < 10 ? `0${idx}` : idx}</span>
                            <span className={`text-[14px] font-black uppercase italic tracking-tighter ${t.completed ? 'text-zinc-400 group-hover:text-zinc-100' : isNext ? 'text-white' : 'text-zinc-300'}`}>{t.name}</span>
                        </div>
                        <div className={`w-8 h-8 rounded-lg border flex items-center justify-center ${t.completed ? 'bg-zinc-800 border-zinc-700' : isNext ? 'bg-red-600/10' : 'border-zinc-800'}`}>
                          {t.completed ? <svg className="w-5 h-5 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M9 5l7 7-7 7" /></svg> : isNext ? <div className="w-2.5 h-2.5 bg-red-600 rounded-full animate-ping"></div> : null}
                        </div>
                      </button>
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
                    <textarea value={metricsInput} onChange={(e) => setMetricsInput(e.target.value)} placeholder="Pegue aquí los registros del servidor (Logs)..." className="w-full h-80 bg-zinc-950 border border-zinc-800 rounded-[2rem] p-8 font-mono text-[12px] text-zinc-400 focus:outline-none focus:border-red-600 transition-all resize-none shadow-2xl placeholder:opacity-20" />
                    <button onClick={handleAnalyzeMetrics} disabled={isAnalyzing || !metricsInput} className="w-full bg-zinc-100 text-zinc-950 font-black py-7 rounded-[1.5rem] uppercase text-[12px] tracking-[0.5em] hover:bg-white transition-all shadow-2xl disabled:opacity-20 flex items-center justify-center gap-6 border-b-6 border-zinc-300 active:border-b-0 active:translate-y-1">{isAnalyzing ? <div className="animate-spin h-6 w-6 border-4 border-zinc-950 border-t-transparent rounded-full" /> : 'Sincronizar Datos de Servidor'}</button>
                  </div>
                  <div className={`flex-1 min-h-[300px] bg-zinc-950/40 border-2 border-dashed border-zinc-800 rounded-[2rem] p-10 flex flex-col justify-center items-center text-center ${analysis ? 'border-solid border-blue-600/30 bg-blue-600/5' : ''}`}>{!analysis && !isAnalyzing && <div className="opacity-20 italic space-y-4"><p className="text-4xl font-black uppercase tracking-tighter">Esperando Datos</p></div>}{analysis && (<div className="text-left space-y-6 animate-in zoom-in-95 duration-700"><h4 className="text-[10px] font-black uppercase text-blue-500 tracking-[0.6em] italic border-b border-blue-900/30 pb-4">Reporte del Comisariato IA</h4><p className="text-[18px] text-zinc-200 font-bold italic leading-[1.8]">"{analysis}"</p></div>)}</div>
                </div>
            </section>
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

            <section className="lg:col-span-6 bg-zinc-900 border border-zinc-800 rounded-[3rem] p-10 shadow-2xl">
              <div className="mb-8 border-b border-zinc-800 pb-6">
                <h2 className="text-[13px] font-black uppercase tracking-[0.3em] text-zinc-400 flex items-center gap-3 italic mb-2">
                  <div className="w-4 h-4 bg-red-600/20 border border-red-600 rotate-45"></div>
                  Estudio de Locución
                </h2>
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
                  <button onClick={handlePlayTTS} disabled={isPlayingTTS || !scripts[activeScriptIdx]} className="flex-1 bg-red-600 text-white font-black py-6 rounded-2xl uppercase text-[12px] tracking-widest hover:bg-red-700 transition-all shadow-xl disabled:opacity-20 flex items-center justify-center gap-4 border-b-4 border-red-900">
                    {isPlayingTTS ? <div className="animate-spin h-6 w-6 border-4 border-white border-t-transparent rounded-full" /> : <><svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>Reproducir Emisión</>}
                  </button>
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

      {/* FOOTER */}
      <footer className="w-full mt-20 md:mt-40 border-t border-zinc-800/50 pt-10 md:pt-20 pb-14 md:pb-28 flex flex-col md:flex-row justify-between items-center text-[9px] md:text-[11px] text-zinc-400 uppercase tracking-[0.3em] md:tracking-[0.6em] px-4 md:px-10 lg:px-32 gap-6 md:gap-12">
        <div className="flex gap-4 md:gap-8 font-black items-center">
          <div className="relative w-16 h-16 md:w-20 md:h-20 flex items-center justify-center p-2 group">
            <img 
              src="/Logo.jpg" 
              alt="Palporro Racing Logo" 
              className="w-full h-full object-contain opacity-60 group-hover:opacity-90 transition-opacity duration-500 drop-shadow-[0_0_15px_rgba(220,38,38,0.4)]" 
            />
          </div>
          <div className="flex flex-col gap-2">
            <span className="hover:text-red-600 transition-colors cursor-pointer text-[8px] md:text-[11px]">
              Palporro Engine v4.0
            </span>
            <a
              href="https://neurasur.nextba.com"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Desarrollado por NeuraSur"
              className="flex items-center gap-3 text-red-500 md:text-[12px] font-extrabold tracking-wider hover:text-red-400 transition-all"
            >
              <img src="/GTR34.png" alt="NeuraSur" className="w-6 h-6 md:w-8 md:h-8 rounded-full object-cover flex-shrink-0 shadow-[0_6px_18px_rgba(220,38,38,0.12)]" />
              <span className="uppercase">Desarrollado por NeuraSur</span>
            </a>
          </div>
        </div>
        <div className="flex flex-col gap-2 md:gap-4 items-center md:items-end">
          <div className="text-red-600/70 font-black italic tracking-tighter text-center md:text-right leading-relaxed hover:text-red-500 transition-colors duration-500 text-[9px] md:text-[11px]">
            "EL DRAGÓN REINA EN 2026. <br/> LA VELOCIDAD ES RESPETO. EL FIASCORE ES LEY."
          </div>
        </div>
      </footer>

      {/* POPUP DE RESULTADOS */}
      {selectedTrack && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/90 backdrop-blur-sm animate-in fade-in duration-300">
           <div className="bg-zinc-900 border-2 border-red-600/50 rounded-[3rem] w-full max-w-2xl overflow-hidden shadow-[0_0_100px_rgba(220,38,38,0.3)] animate-in zoom-in-95 duration-500">
              <div className="bg-zinc-800 p-8 border-b border-zinc-700 flex justify-between items-center">
                 <div><p className="text-[10px] font-black text-red-600 uppercase tracking-[0.5em] mb-2 italic">Histórico de Telemetría</p><h3 className="text-3xl font-black uppercase italic tracking-tighter text-white">{selectedTrack} GP</h3></div>
                 <button onClick={() => setSelectedTrack(null)} className="p-4 hover:bg-red-600 transition-colors rounded-2xl group"><svg className="w-6 h-6 text-zinc-500 group-hover:text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M6 18L18 6M6 6l12 12" /></svg></button>
              </div>
              <div className="p-10 space-y-8">
                 <div className="space-y-4">
                    <h4 className="text-[11px] font-black uppercase tracking-[0.3em] text-zinc-500 border-b border-zinc-800 pb-2 italic">Resultados Finales</h4>
                    {selectedTrack === 'Training' ? (
                      <div className="space-y-2">
                        <div className="bg-zinc-950 p-5 rounded-xl border border-zinc-800 flex justify-between items-center"><span className="flex items-center gap-4"><span className="text-yellow-500 font-black italic">P1</span><span className="font-black uppercase italic tracking-tight">Slayer</span></span><span className="font-mono text-[12px] text-zinc-500">01:42.553</span></div>
                        <div className="bg-zin c-950 p-5 rounded-xl border border-zinc-800 flex justify-between items-center"><span className="flex items-center gap-4"><span className="text-zinc-400 font-black italic">P2</span><span className="font-black uppercase italic tracking-tight">TheSmokeSeller</span></span><span className="font-mono text-[12px] text-zinc-500">+1.240s</span></div>
                        <div className="bg-zinc-950 p-5 rounded-xl border border-zinc-800 flex justify-between items-center"><span className="flex items-center gap-4"><span className="text-orange-700 font-black italic">P3</span><span className="font-black uppercase italic tracking-tight">Ale</span></span><span className="font-mono text-[12px] text-zinc-500">+5.892s</span></div>
                      </div>
                    ) : (
                      <div className="bg-zinc-950/50 p-10 rounded-2xl border-2 border-dashed border-zinc-800 flex flex-col items-center justify-center text-zinc-700 text-center"><svg className="w-12 h-12 mb-4 opacity-20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg><p className="font-black uppercase tracking-[0.4em] text-[10px] italic">Esperando sesión oficial de carrera en Assetto Corsa</p></div>
                    )}
                 </div>
                 <div className="bg-red-600/5 p-6 rounded-2xl border border-red-600/20 italic">
                    <p className="text-[10px] text-red-600 font-black uppercase tracking-[0.2em] mb-2">Aviso del Comisariato:</p>
                    <p className="text-[12px] text-zinc-400 font-bold leading-relaxed">"Los datos mostrados para la sesión de Training son resultados provisorios y de carácter puramente demostrativo. Quedan sujetos a los resultados reales procesados vía logs de servidor tras el cierre de cada GP."</p>
                 </div>
              </div>
              <div className="p-8 bg-zinc-950 flex justify-end border-t border-zinc-800"><button onClick={() => setSelectedTrack(null)} className="px-10 py-4 bg-zinc-100 text-zinc-950 font-black uppercase text-[12px] tracking-widest rounded-2xl hover:bg-white transition-all">Cerrar Archivo</button></div>
           </div>
        </div>
      )}

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
    </div>
  );
}

export default App;
