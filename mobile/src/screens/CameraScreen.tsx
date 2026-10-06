// ============================================================
// PANTALLA: CÁMARA (Vigilancia en tiempo real)
// ============================================================
// Captura imágenes con la cámara del celular y las envía
// al backend para análisis de movimiento.

import React, { useRef, useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  Animated,
  Dimensions,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Ionicons } from "@expo/vector-icons";
import { StatusBar } from "expo-status-bar";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";

import { CONFIG } from "../config";
import { COLORS, SPACING, RADIUS, FONT } from "../theme";
import {
  initNotifications,
  showArmedNotification,
  clearArmedNotification,
  notifyAlarm,
} from "../services/notifications";
import { sendImageForAnalysis, resetReference, type AnalysisResult } from "../services/api";

const { width: SCREEN_W } = Dimensions.get("window");

export default function CameraScreen() {
  // ---- Permisos ----
  const [permission, requestPermission] = useCameraPermissions();

  // ---- Estado ----
  const cameraRef = useRef<CameraView>(null);
  const [isMonitoring, setIsMonitoring] = useState(false);
  const [lastResult, setLastResult] = useState<AnalysisResult | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [facing, setFacing] = useState<"front" | "back">("back");
  const [captureCount, setCaptureCount] = useState(0);
  const [pictureSize, setPictureSize] = useState<string | undefined>(undefined);

  // Refs (no se quedan "congelados" dentro del bucle asíncrono como el estado)
  const sendingRef = useRef(false);
  const runIdRef = useRef(0); // Cambia al detener/iniciar: corta el bucle anterior

  // Animaciones
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const alertAnim = useRef(new Animated.Value(0)).current;

  // ---- Pulso de grabación ----
  useEffect(() => {
    if (isMonitoring) {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.3, duration: 800, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 800, useNativeDriver: true }),
        ])
      );
      loop.start();
      return () => loop.stop();
    } else {
      pulseAnim.setValue(1);
    }
  }, [isMonitoring]);

  // ---- Notificaciones: permisos al abrir ----
  useEffect(() => {
    initNotifications();
  }, []);

  // ---- Notificación persistente "Sistema armado" + pantalla encendida ----
  // La cámara de Android solo captura con la app en primer plano, así que
  // mantenemos la pantalla activa mientras vigila y dejamos la notificación
  // fija para volver rápido a la app.
  useEffect(() => {
    if (isMonitoring) {
      showArmedNotification();
      activateKeepAwakeAsync("monitoring").catch(() => {});
    } else {
      clearArmedNotification();
      deactivateKeepAwake("monitoring");
    }
    return () => {
      deactivateKeepAwake("monitoring");
    };
  }, [isMonitoring]);

  // ---- Flash de alerta + notificación de alarma ----
  useEffect(() => {
    if (lastResult?.alarm_triggered) {
      notifyAlarm(lastResult.diff_percentage);
      Animated.sequence([
        Animated.timing(alertAnim, { toValue: 1, duration: 150, useNativeDriver: true }),
        Animated.timing(alertAnim, { toValue: 0, duration: 150, useNativeDriver: true }),
        Animated.timing(alertAnim, { toValue: 1, duration: 150, useNativeDriver: true }),
        Animated.timing(alertAnim, { toValue: 0, duration: 600, useNativeDriver: true }),
      ]).start();
    }
  }, [lastResult?.alarm_triggered]);

  // ---- Resolución de captura ----
  // Por defecto la cámara toma fotos a resolución completa (varios MB en
  // base64), lo que hacía cada captura lenta. Elegimos la más pequeña útil.
  const choosePictureSize = useCallback(async () => {
    try {
      const sizes = (await cameraRef.current?.getAvailablePictureSizesAsync()) ?? [];
      const parsed = sizes
        .map((s) => {
          const m = /^(\d+)x(\d+)$/.exec(s);
          return m ? { s, long: Math.max(+m[1], +m[2]), area: +m[1] * +m[2] } : null;
        })
        .filter((p): p is { s: string; long: number; area: number } => p !== null)
        .sort((a, b) => a.area - b.area);
      const pick = parsed.find((p) => p.long >= CONFIG.PICTURE_MIN_SIDE) ?? parsed[parsed.length - 1];
      if (pick) setPictureSize(pick.s);
    } catch (e) {
      console.warn("No se pudieron leer las resoluciones de la cámara:", e);
    }
  }, []);

  // ---- Captura y envío ----
  const captureAndSend = useCallback(async () => {
    if (!cameraRef.current || sendingRef.current) return;

    sendingRef.current = true;
    try {
      setIsSending(true);
      setError(null);

      // Capturar foto (sin sonido ni procesamiento extra: más rápido)
      const photo = await cameraRef.current.takePictureAsync({
        quality: CONFIG.JPEG_QUALITY,
        base64: true,
        skipProcessing: true,
        shutterSound: false,
      });

      if (!photo?.base64) {
        throw new Error("No se pudo capturar la imagen");
      }

      setCaptureCount((c) => c + 1);

      // Enviar al backend
      const result = await sendImageForAnalysis(photo.base64);
      setLastResult(result);

    } catch (e: any) {
      const msg = e.message || "Error desconocido";
      setError(msg);
      console.warn("Error en captura:", msg);
    } finally {
      sendingRef.current = false;
      setIsSending(false);
    }
  }, []);

  // ---- Control de monitoreo continuo ----
  // Bucle en vez de setInterval fijo: la siguiente foto sale apenas termina
  // el análisis anterior (con un mínimo de CAPTURE_INTERVAL_MS), sin huecos
  // largos donde un movimiento rápido pasaba sin ser fotografiado.
  const monitorLoop = useCallback(async (runId: number) => {
    while (runIdRef.current === runId) {
      const started = Date.now();
      await captureAndSend();
      const wait = CONFIG.CAPTURE_INTERVAL_MS - (Date.now() - started);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  }, [captureAndSend]);

  const toggleMonitoring = useCallback(() => {
    runIdRef.current += 1;
    if (isMonitoring) {
      // Detener (el bucle termina al ver que cambió runId)
      setIsMonitoring(false);
    } else {
      // Iniciar
      setIsMonitoring(true);
      setCaptureCount(0);
      setLastResult(null);
      monitorLoop(runIdRef.current);
    }
  }, [isMonitoring, monitorLoop]);

  // Cambiar de cámara: la escena es otra, así que se pide nueva referencia
  const flipCamera = useCallback(() => {
    setFacing((f) => (f === "back" ? "front" : "back"));
    setPictureSize(undefined);
    resetReference().catch((e) => console.warn("No se pudo resetear la referencia:", e));
  }, []);

  // Cleanup al desmontar: corta el bucle de captura
  useEffect(() => {
    return () => {
      runIdRef.current += 1;
    };
  }, []);

  // ---- Render: Sin permisos ----
  if (!permission) return <View style={styles.container} />;

  if (!permission.granted) {
    return (
      <View style={styles.permissionContainer}>
        <StatusBar style="light" />
        <Ionicons name="camera-outline" size={64} color={COLORS.primary} />
        <Text style={styles.permissionTitle}>Acceso a Cámara</Text>
        <Text style={styles.permissionText}>
          La app necesita acceso a la cámara para{"\n"}vigilar y detectar movimiento.
        </Text>
        <TouchableOpacity style={styles.permissionBtn} onPress={requestPermission}>
          <Text style={styles.permissionBtnText}>Permitir Cámara</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ---- Render: Cámara ----
  return (
    <View style={styles.container}>
      <StatusBar style="light" />

      {/* Flash rojo de alerta */}
      <Animated.View
        style={[
          styles.alertFlash,
          { opacity: alertAnim },
        ]}
        pointerEvents="none"
      />

      {/* Cámara */}
      <CameraView
        ref={cameraRef}
        style={styles.camera}
        facing={facing}
        pictureSize={pictureSize}
        animateShutter={false}
        onCameraReady={choosePictureSize}
      >
        {/* Overlay superior */}
        <View style={styles.topOverlay}>
          <View style={styles.topLeft}>
            <Animated.View
              style={[
                styles.recordDot,
                isMonitoring && { transform: [{ scale: pulseAnim }] },
                !isMonitoring && { backgroundColor: COLORS.textMuted },
              ]}
            />
            <Text style={styles.topLabel}>
              {isMonitoring ? "VIGILANDO" : "EN ESPERA"}
            </Text>
          </View>
          <TouchableOpacity
            style={styles.flipBtn}
            onPress={flipCamera}
          >
            <Ionicons name="camera-reverse-outline" size={22} color={COLORS.textPrimary} />
          </TouchableOpacity>
        </View>

        {/* Marco de enfoque */}
        <View style={styles.focusFrame} />

        {/* Info de resultado */}
        {lastResult && (
          <View style={styles.resultOverlay}>
            <View
              style={[
                styles.resultBadge,
                lastResult.motion_detected
                  ? styles.resultBadgeDanger
                  : styles.resultBadgeOk,
              ]}
            >
              <Ionicons
                name={lastResult.motion_detected ? "warning" : "checkmark-circle"}
                size={16}
                color={lastResult.motion_detected ? COLORS.danger : COLORS.success}
              />
              <Text
                style={[
                  styles.resultText,
                  { color: lastResult.motion_detected ? COLORS.danger : COLORS.success },
                ]}
              >
                {lastResult.motion_detected
                  ? `Movimiento: ${lastResult.diff_percentage.toFixed(1)}%`
                  : "Sin movimiento"}
              </Text>
            </View>
            {lastResult.alarm_triggered && (
              <View style={styles.alarmBadge}>
                <Ionicons name="notifications" size={14} color="#FFF" />
                <Text style={styles.alarmBadgeText}>¡ALARMA ACTIVADA!</Text>
              </View>
            )}
          </View>
        )}
      </CameraView>

      {/* Panel inferior */}
      <View style={styles.bottomPanel}>
        {/* Estadísticas */}
        <View style={styles.statsRow}>
          <View style={styles.statItem}>
            <Text style={styles.statValue}>{captureCount}</Text>
            <Text style={styles.statLabel}>Capturas</Text>
          </View>
          <View style={styles.statItem}>
            <Text style={styles.statValue}>
              {lastResult ? `${lastResult.diff_percentage.toFixed(1)}%` : "—"}
            </Text>
            <Text style={styles.statLabel}>Cambio</Text>
          </View>
          <View style={styles.statItem}>
            <Text
              style={[
                styles.statValue,
                { color: lastResult?.within_schedule ? COLORS.success : COLORS.warning },
              ]}
            >
              {lastResult?.within_schedule ? "SÍ" : "NO"}
            </Text>
            <Text style={styles.statLabel}>En horario</Text>
          </View>
        </View>

        {/* Error */}
        {error && (
          <View style={styles.errorBar}>
            <Ionicons name="alert-circle" size={16} color={COLORS.danger} />
            <Text style={styles.errorText} numberOfLines={1}>
              {error}
            </Text>
          </View>
        )}

        {/* Botones */}
        <View style={styles.btnRow}>
          {/* Captura manual */}
          <TouchableOpacity
            style={[styles.secondaryBtn]}
            onPress={captureAndSend}
            disabled={isSending || isMonitoring}
          >
            <Ionicons name="camera" size={20} color={COLORS.primary} />
          </TouchableOpacity>

          {/* Botón principal: Iniciar / Detener */}
          <TouchableOpacity
            style={[
              styles.mainBtn,
              isMonitoring ? styles.mainBtnStop : styles.mainBtnStart,
            ]}
            onPress={toggleMonitoring}
          >
            <Ionicons
              name={isMonitoring ? "stop" : "play"}
              size={28}
              color="#FFF"
            />
          </TouchableOpacity>

          {/* Captura individual (placeholder simétrico) */}
          <TouchableOpacity
            style={[styles.secondaryBtn]}
            onPress={() => setLastResult(null)}
            disabled={!lastResult}
          >
            <Ionicons name="refresh" size={20} color={COLORS.primary} />
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

// ============================================================
// ESTILOS
// ============================================================

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },

  // ---- Permisos ----
  permissionContainer: {
    flex: 1,
    backgroundColor: COLORS.bg,
    justifyContent: "center",
    alignItems: "center",
    padding: SPACING.xxxl,
  },
  permissionTitle: {
    color: COLORS.textPrimary,
    fontSize: FONT.xl,
    fontWeight: FONT.bold,
    marginTop: SPACING.xl,
    marginBottom: SPACING.sm,
  },
  permissionText: {
    color: COLORS.textSecondary,
    fontSize: FONT.md,
    textAlign: "center",
    lineHeight: 22,
    marginBottom: SPACING.xxl,
  },
  permissionBtn: {
    backgroundColor: COLORS.primary,
    paddingHorizontal: SPACING.xxxl,
    paddingVertical: SPACING.lg,
    borderRadius: RADIUS.lg,
  },
  permissionBtnText: {
    color: "#FFF",
    fontSize: FONT.md,
    fontWeight: FONT.bold,
  },

  // ---- Cámara ----
  camera: {
    flex: 1,
  },
  alertFlash: {
    position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: "rgba(239, 68, 68, 0.3)",
    zIndex: 100,
  },

  // ---- Overlay superior ----
  topOverlay: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingTop: 56,
    paddingHorizontal: SPACING.xl,
  },
  topLeft: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.5)",
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
    borderRadius: RADIUS.full,
  },
  recordDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: COLORS.danger,
    marginRight: SPACING.sm,
  },
  topLabel: {
    color: COLORS.textPrimary,
    fontSize: FONT.sm,
    fontWeight: FONT.bold,
    letterSpacing: 1,
  },
  flipBtn: {
    backgroundColor: "rgba(0,0,0,0.5)",
    padding: SPACING.sm,
    borderRadius: RADIUS.full,
  },

  // ---- Marco de enfoque ----
  focusFrame: {
    position: "absolute",
    top: "25%",
    left: "15%",
    width: "70%",
    height: "40%",
    borderWidth: 1.5,
    borderColor: "rgba(59, 130, 246, 0.4)",
    borderRadius: RADIUS.lg,
  },

  // ---- Resultado ----
  resultOverlay: {
    position: "absolute",
    bottom: 16,
    left: 16,
    right: 16,
    alignItems: "center",
  },
  resultBadge: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    borderRadius: RADIUS.full,
    gap: SPACING.xs,
  },
  resultBadgeOk: {
    backgroundColor: "rgba(34, 197, 94, 0.2)",
    borderWidth: 1,
    borderColor: "rgba(34, 197, 94, 0.3)",
  },
  resultBadgeDanger: {
    backgroundColor: "rgba(239, 68, 68, 0.2)",
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.3)",
  },
  resultText: {
    fontSize: FONT.sm,
    fontWeight: FONT.semibold,
  },
  alarmBadge: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: COLORS.danger,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
    borderRadius: RADIUS.full,
    marginTop: SPACING.sm,
    gap: SPACING.xs,
  },
  alarmBadgeText: {
    color: "#FFF",
    fontSize: FONT.xs,
    fontWeight: FONT.bold,
    letterSpacing: 0.5,
  },

  // ---- Panel inferior ----
  bottomPanel: {
    backgroundColor: COLORS.bgCard,
    paddingHorizontal: SPACING.xl,
    paddingTop: SPACING.lg,
    paddingBottom: SPACING.xxxl,
    borderTopLeftRadius: RADIUS.xl,
    borderTopRightRadius: RADIUS.xl,
  },

  // ---- Stats ----
  statsRow: {
    flexDirection: "row",
    justifyContent: "space-around",
    marginBottom: SPACING.lg,
  },
  statItem: {
    alignItems: "center",
  },
  statValue: {
    color: COLORS.textPrimary,
    fontSize: FONT.lg,
    fontWeight: FONT.bold,
  },
  statLabel: {
    color: COLORS.textMuted,
    fontSize: FONT.xs,
    marginTop: 2,
  },

  // ---- Error ----
  errorBar: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: COLORS.dangerBg,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: RADIUS.sm,
    marginBottom: SPACING.md,
    gap: SPACING.sm,
  },
  errorText: {
    color: COLORS.danger,
    fontSize: FONT.sm,
    flex: 1,
  },

  // ---- Botones ----
  btnRow: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: SPACING.xl,
  },
  mainBtn: {
    width: 68,
    height: 68,
    borderRadius: 34,
    justifyContent: "center",
    alignItems: "center",
    elevation: 8,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
  mainBtnStart: {
    backgroundColor: COLORS.success,
  },
  mainBtnStop: {
    backgroundColor: COLORS.danger,
  },
  secondaryBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: COLORS.bgAccent,
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1,
    borderColor: COLORS.border,
  },
});
