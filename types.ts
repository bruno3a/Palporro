
export interface Standing {
  pilot: string;
  points: number;
  lastResult: string;
  racesRun: number;
  incidences: number;
  wins?: number;
}

export interface TrackStatus {
  name: string;
  completed: boolean;
}

export enum ConnectionStatus {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  ERROR = 'ERROR'
}

export interface Standing {
  pilot: string;
  points: number;
  lastResult: string;
  racesRun: number;
  incidences: number;
  wins?: number;
  fastestLaps?: number; // ✅ contador acumulado de mejores vueltas en la temporada
}