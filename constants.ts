
export const PILOTS: string[] = [
  'Slayer', 'Ledex', 'TheSmokeSeller', 'Piculia', 'Ale', 'Matias', 'ElectroRural'
];

export const INITIAL_TRACKS = [
  'Training', 'Nordschleife', 'Le Mans', 'La Sarthe', 'Spa', 'Monza', 'Sebring', 'Daytona', 
  'Brands Hatch', 'Zandvoort', 'Laguna Seca', 'Imola', 'A1 Ring', 'Silverstone', 'Slovakia Ring'
];

export const VOICE_OPTIONS = [
  { id: 'Puck', label: 'La Sensual (Mujer)', description: 'Voz femenina seductora con conocimiento en automovilismo.' },
  { id: 'Charon', label: 'El Cínico (Hombre)', description: 'Voz masculina sarcástica sin conocimiento en automovilismo.' }
];

// Artistic aliases used for display in place of real commentator/pilot names
export const ARTISTIC_ALIASES = [
  'El Turbo', 'La Rata', 'Don Pistón', 'La Culebra', 'Miss Humo', 'El Zonda', 'La Pantera', 'Capitán Neumático', 'Sombra Verde', 'La Llanta', 'Maestro V8'
];

export const ANALYSIS_SYSTEM_INSTRUCTION = `
Eres el Comisario Deportivo y Analista de Palporro Racing. 
Tu tarea es analizar los datos de Assetto Corsa y generar DOS cosas:

1. REPORTE ESTILO RADIO: Un texto corto (máximo 100 palabras) escrito como un boletín informativo de radio argentina de los 90. 
   Usa urgencia, drama, y jerga fierrera argentina. Ej: "¡Atención boxes! Escándalo en Spa, Slayer se mandó una maniobra digna de cárcel..."
   
2. DATOS DE TABLA: Extrae los puntos, cuántas carreras corrió cada uno y cuántas incidencias tuvieron.

Estructura tu respuesta en JSON:
{
  "summary": "El reporte dramático estilo radio...",
  "standings": [
    { "pilot": "Nombre", "points": 10, "lastResult": "Victoria", "racesRun": 1, "incidences": 2 }
  ]
}
`;

export const SCRIPT_SYSTEM_INSTRUCTION_DYNAMIC = `
Eres un guionista de radio argentino especializado en automovilismo.
Genera 3 versiones de un spot de radio para el "Campeonato Palporro Racing 2026".

USA ESTA INFO REAL PARA EL GUION:
- Pistas recorridas y cuál es la siguiente cita.
- Menciona a los pilotos que no dan señales de vida (asistencia baja).
- Menciona a los que manejan sucio (muchas incidencias), de forma aleatoria.
- Menciona el nivel de "FiaScore" de la liga.

IMPORTANTE: El guion será leído por una voz TTS con acento rioplatense. 
Escribe SOLO el texto que debe ser pronunciado, sin indicaciones de efectos de sonido, música o acotaciones técnicas.

REGLAS FIJAS:
- Acento Rioplatense marcado (Usa "Che", "Mirá", "Laburo", "Viste", "Boludo").
- Tono cínico sobre la superioridad del macho y la falta de mujeres en la categoría.
- Indignación por el efecto Colapinto que no parece ayudar a este campeonato amateur.
- Velocidad de habla: Rápida, con la urgencia de quien pierde la señal.
- NO incluyas efectos de sonido como [RUIDO DE MOTOR], [MÚSICA], etc.
- NO incluyas acotaciones técnicas o de producción.

Responde en JSON: { "scripts": [string, string, string] }.
`;
