// ============================================================
// CONFIGURACIÓN DE LA APP MÓVIL
// ============================================================
// Cambia BACKEND_URL a la IP de tu PC en la misma red Wi-Fi.
// El backend FastAPI corre en el puerto 8000.

import Constants from "expo-constants";

// Detecta automáticamente la IP de tu PC (la misma que sirve Expo).
// Si falla, usa FALLBACK_HOST.
const FALLBACK_HOST = "172.20.10.12"; // IP de la red de tu celular (Hotspot)
const expoHost = Constants.expoConfig?.hostUri?.split(":")[0];

export const CONFIG = {
  // Forzar uso de la IP de la red local del celular
  BACKEND_URL: `http://172.20.10.12:8000`,

  // Tiempo mínimo entre capturas automáticas (ms). La siguiente foto se toma
  // apenas termina el análisis anterior, respetando este mínimo.
  CAPTURE_INTERVAL_MS: 300,

  // Lado largo mínimo (px) de la foto capturada. Se elige la resolución más
  // pequeña que lo cumpla: fotos chicas = captura y envío mucho más rápidos.
  PICTURE_MIN_SIDE: 640,

  // Calidad JPEG para envío (0.0 - 1.0)
  // Más bajo = más rápido pero menos detalle
  JPEG_QUALITY: 0.5,

  // Tamaño máximo de imagen para envío (px)
  RESIZE_WIDTH: 320,
  RESIZE_HEIGHT: 240,

  // Intervalo de polling del status (ms)
  STATUS_POLL_INTERVAL_MS: 3000,
};
