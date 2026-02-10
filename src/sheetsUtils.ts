import { getEnvironment } from './supabaseClient';

const SPREADSHEET_ID = (import.meta as any).env?.VITE_GOOGLE_SHEET_ID;
const API_KEY = (import.meta as any).env?.VITE_GOOGLE_SHEETS_API_KEY;
// Use the same environment resolution as the Supabase client so both
// data sources (Supabase and Sheets proxy) behave consistently.
const ENVIRONMENT = getEnvironment();

interface VoteData {
  pilot: string;
  days: string[];
  times: string[];
  timestamp: number;
}

// Leer votos (usando API Key - solo lectura)
export async function getVotes(): Promise<VoteData[]> {
  try {
    const range = `${ENVIRONMENT}!A2:D`;
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${range}?key=${API_KEY}`;
    
    const response = await fetch(url);
    const data = await response.json();
    
    if (!data.values || data.values.length === 0) {
      return [];
    }
    
    return data.values.map((row: string[]) => ({
      pilot: row[0] || '',
      days: JSON.parse(row[1] || '[]'),
      times: JSON.parse(row[2] || '[]'),
      timestamp: parseInt(row[3] || '0')
    })).filter(vote => vote.pilot !== '');
    
  } catch (error) {
    console.error('Error fetching votes:', error);
    return [];
  }
}

// Escribir voto (usando backend proxy)
export async function addVote(voteData: VoteData): Promise<boolean> {
  try {
    const response = await fetch('/api/vote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...voteData,
        environment: ENVIRONMENT
      })
    });
    
    const data = await response.json();
    return data.success;
    
  } catch (error) {
    console.error('Error adding vote:', error);
    return false;
  }
}

import { getEnvironment } from './supabaseClient';

const SPREADSHEET_ID = (import.meta as any).env?.VITE_GOOGLE_SHEET_ID;
const API_KEY = (import.meta as any).env?.VITE_GOOGLE_SHEETS_API_KEY;
// Use the same environment resolution as the Supabase client so both
// data sources (Supabase and Sheets proxy) behave consistently.
const ENVIRONMENT = getEnvironment();

interface VoteData {
  pilot: string;
  days: string[];
  times: string[];
  timestamp: number;
}

// Leer votos (usando API Key - solo lectura)
export async function getVotes(): Promise<VoteData[]> {
  try {
    const range = `${ENVIRONMENT}!A2:D`;
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${range}?key=${API_KEY}`;
    
    const response = await fetch(url);
    const data = await response.json();
    
    if (!data.values || data.values.length === 0) {
      return [];
    }
    
    return data.values.map((row: string[]) => ({
      pilot: row[0] || '',
      days: JSON.parse(row[1] || '[]'),
      times: JSON.parse(row[2] || '[]'),
      timestamp: parseInt(row[3] || '0')
    })).filter(vote => vote.pilot !== '');
    
  } catch (error) {
    console.error('Error fetching votes:', error);
    return [];
  }
}

// Escribir voto (usando backend proxy)
export async function addVote(voteData: VoteData): Promise<boolean> {
  try {
    const response = await fetch('/api/vote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...voteData,
        environment: ENVIRONMENT
      })
    });
    
    const data = await response.json();
    return data.success;
    
  } catch (error) {
    console.error('Error adding vote:', error);
    return false;
  }
}

