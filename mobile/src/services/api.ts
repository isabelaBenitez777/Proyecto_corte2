// ============================================================
// API SERVICE — Comunicación con el Backend FastAPI
// ============================================================
// Todas las llamadas HTTP al backend centralizadas aquí.

import { CONFIG } from "../config";

const BASE = CONFIG.BACKEND_URL;

/**
 * Helper para inyectar headers requeridos por localtunnel.
 */
async function fetchApi(endpoint: string, options: RequestInit = {}) {
  const headers = {
    "Bypass-Tunnel-Reminder": "true",
    ...options.headers,
  };
  return fetch(`${BASE}${endpoint}`, { ...options, headers });
}

// ---- Tipos de respuesta ----

export interface AnalysisResult {
  motion_detected: boolean;
  diff_percentage: number;
  changed_pixels: number;
  total_pixels: number;
  alarm_triggered: boolean;
  within_schedule: boolean;
  cooldown_active: boolean;
  message: string;
}

export interface BackendStatus {
  backend: string;
  detection_active: boolean;
  total_analyses: number;
  total_detections: number;
  last_diff_pct: number;
  last_alert: string | null;
  cooldown_seconds: number;
  cooldown_active: boolean;
  schedule: {
    start: string;
    end: string;
    currently_active: boolean;
  };
  esp32_ip: string;
  has_reference_frame: boolean;
}

// ---- Funciones ----

/**
 * Envía una imagen JPEG en base64 al backend para análisis.
 */
export async function sendImageForAnalysis(base64Image: string): Promise<AnalysisResult> {
  const resp = await fetchApi(`/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: base64Image }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Análisis falló (${resp.status}): ${text}`);
  }

  return resp.json();
}

/**
 * Obtiene el estado actual del backend.
 */
export async function getBackendStatus(): Promise<BackendStatus> {
  const resp = await fetchApi(`/status`);
  if (!resp.ok) throw new Error(`Status falló (${resp.status})`);
  return resp.json();
}

/**
 * Activa la detección de movimiento.
 */
export async function enableDetection(): Promise<void> {
  await fetchApi(`/detection/on`, { method: "POST" });
}

/**
 * Desactiva la detección de movimiento.
 */
export async function disableDetection(): Promise<void> {
  await fetchApi(`/detection/off`, { method: "POST" });
}

/**
 * Dispara la alarma manualmente.
 */
export async function triggerAlarm(): Promise<{ alarm: string; esp32_reached: boolean }> {
  const resp = await fetchApi(`/alarm/trigger`, { method: "POST" });
  return resp.json();
}

/**
 * Silencia la alarma.
 */
export async function silenceAlarm(): Promise<void> {
  await fetchApi(`/alarm/silence`, { method: "POST" });
}

/**
 * Configura la franja horaria de vigilancia.
 */
export async function setSchedule(start: string, end: string): Promise<void> {
  await fetchApi(`/schedule`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ start, end }),
  });
}

/**
 * Resetea el frame de referencia.
 */
export async function resetReference(): Promise<void> {
  await fetchApi(`/reset-reference`, { method: "POST" });
}

/**
 * Obtiene el correo de alertas actual.
 */
export async function getAlertEmail(): Promise<{ email: string }> {
  const resp = await fetchApi(`/alert-email`);
  if (!resp.ok) throw new Error("Error obteniendo correo");
  return resp.json();
}

/**
 * Configura el correo de destino para alertas.
 */
export async function setAlertEmail(email: string): Promise<void> {
  const resp = await fetchApi(`/alert-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Error guardando correo: ${text}`);
  }
}

/**
 * Envía un correo de prueba.
 */
export async function testAlertEmail(): Promise<void> {
  const resp = await fetchApi(`/alert-email/test`, { method: "POST" });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Error enviando correo: ${text}`);
  }
}
