// pilotMapping.ts
// Mapeo entre nombres de pilotos en la app y nombres en Assetto Corsa

/**
 * Mapeo de pilotos: App Name → AC Names
 * 
 * Cada piloto puede tener múltiples variantes de nombre en AC
 * (mayúsculas, minúsculas, espacios, etc.)
 */

export interface PilotMapping {
  appName: string;           // Nombre en la aplicación Palporro
  acNames: string[];         // Posibles nombres en Assetto Corsa (case-insensitive)
  primaryAcName: string;     // Nombre principal/preferido en AC
}

export const PILOT_MAPPINGS: PilotMapping[] = [
  {
    appName: 'Electrorural',
    acNames: ['K-T-E', 'k-t-e', 'KTE', 'kte', 'Electrorural', 'electrorural','ElectroRural'],
    primaryAcName: 'K-T-E'
  },
  {
    appName: 'Slayer',
    acNames: ['S L A Y E R', 's l a y e r', 'SLAYER', 'slayer', 'Slayer'],
    primaryAcName: 'Slayer'
  },
  {
    appName: 'Ledex',
    acNames: ['Ledex', 'ledex', 'LEDEX'],
    primaryAcName: 'Ledex'
  },
  // Agregar más pilotos aquí siguiendo el mismo patrón
  {
    appName: 'Smokeseller',
    acNames: ['Martin Solimo', 'Martin Sólimo', 'Martin', 'TheSmokeSeller', 'thesmokeseller', 'Smokeseller', 'smokeseller','SmokeSeller'],
    primaryAcName: 'Smokeseller'
  },
  {
    appName: 'JP',
    acNames: ['JP', 'Juan Pablo', 'juan pablo'],
    primaryAcName: 'JP'
  },
  {
    appName: 'Fede',
    acNames: ['Fede', 'fede', 'FEDE', 'Federico', 'federico'],
    primaryAcName: 'Fede'
  },
  // ... continuar con todos los pilotos
];

/**
 * Normaliza un nombre de AC a nombre de la app
 * @param acName - Nombre del piloto en AC (del JSON)
 * @returns Nombre del piloto en la app o null si no se encuentra
 */
export function normalizeAcNameToApp(acName: string): string | null {
  const normalized = acName.trim();
  
  // Buscar coincidencia exacta (case-insensitive)
  for (const mapping of PILOT_MAPPINGS) {
    const found = mapping.acNames.some(
      name => name.toLowerCase() === normalized.toLowerCase()
    );
    if (found) {
      return mapping.appName;
    }
  }
  
  // Si no encuentra coincidencia exacta, buscar coincidencia parcial
  for (const mapping of PILOT_MAPPINGS) {
    const found = mapping.acNames.some(
      name => name.toLowerCase().includes(normalized.toLowerCase()) ||
              normalized.toLowerCase().includes(name.toLowerCase())
    );
    if (found) {
      return mapping.appName;
    }
  }
  
  return null;
}

/**
 * Convierte un nombre de la app a nombre de AC (principal)
 * @param appName - Nombre del piloto en la app
 * @returns Nombre principal en AC o el mismo nombre si no hay mapeo
 */
export function normalizeAppNameToAc(appName: string): string {
  const mapping = PILOT_MAPPINGS.find(
    m => m.appName.toLowerCase() === appName.toLowerCase()
  );
  return mapping ? mapping.primaryAcName : appName;
}

/**
 * Obtiene todas las posibles variantes de nombre de un piloto
 * @param appName - Nombre del piloto en la app
 * @returns Array de todas las variantes posibles
 */
export function getAllAcNamesForPilot(appName: string): string[] {
  const mapping = PILOT_MAPPINGS.find(
    m => m.appName.toLowerCase() === appName.toLowerCase()
  );
  return mapping ? mapping.acNames : [appName];
}

/**
 * Valida si un nombre de AC pertenece a un piloto conocido
 * @param acName - Nombre del piloto en AC
 * @returns true si el piloto está en el mapeo
 */
export function isKnownPilot(acName: string): boolean {
  return normalizeAcNameToApp(acName) !== null;
}

/**
 * Procesa una lista de resultados de AC y normaliza los nombres
 * @param results - Array de resultados con nombre del piloto
 * @returns Array con nombres normalizados
 */
export function normalizeRaceResults<T extends { pilot?: string; nombre?: string; name?: string }>(
  results: T[]
): (T & { normalizedName: string; originalName: string })[] {
  return results.map(result => {
    // Detectar el campo que contiene el nombre del piloto
    const originalName = result.pilot || result.nombre || result.name || 'Unknown';
    const normalizedName = normalizeAcNameToApp(originalName) || originalName;
    
    return {
      ...result,
      normalizedName,
      originalName
    };
  });
}

/**
 * Genera reporte de nombres no mapeados (útil para debugging)
 * @param acNames - Array de nombres encontrados en AC
 * @returns Array de nombres que no tienen mapeo
 */
export function getUnmappedPilots(acNames: string[]): string[] {
  return acNames.filter(name => !isKnownPilot(name));
}

// Ejemplo de uso:
/*
// En el procesador de telemetría:
const rawResults = [
  { nombre: "K-T-E", tiempo: "1:23.456" },
  { nombre: "S L A Y E R", tiempo: "1:24.123" },
  { nombre: "Ledex", tiempo: "1:25.789" }
];

const normalized = normalizeRaceResults(rawResults);
// Resultado:
// [
//   { nombre: "K-T-E", tiempo: "1:23.456", normalizedName: "Electrorural", originalName: "K-T-E" },
//   { nombre: "S L A Y E R", tiempo: "1:24.123", normalizedName: "Slayer", originalName: "S L A Y E R" },
//   { nombre: "Ledex", tiempo: "1:25.789", normalizedName: "Ledex", originalName: "Ledex" }
// ]
*/