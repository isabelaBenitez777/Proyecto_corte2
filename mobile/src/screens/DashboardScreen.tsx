// ============================================================
// PANTALLA: DASHBOARD (Estado del sistema)
// ============================================================
// Muestra el estado del backend, ESP32, y últimas detecciones.

import React, { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  Animated,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { StatusBar } from "expo-status-bar";

import { CONFIG } from "../config";
import { COLORS, SPACING, RADIUS, FONT } from "../theme";
import { getBackendStatus, type BackendStatus } from "../services/api";

export default function DashboardScreen() {
  const [status, setStatus] = useState<BackendStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      setError(null);
      const data = await getBackendStatus();
      setStatus(data);
    } catch (e: any) {
      setError(e.message || "No se pudo conectar al backend");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Polling periódico
  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, CONFIG.STATUS_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchStatus();
  }, [fetchStatus]);

  return (
    <View style={styles.container}>
      <StatusBar style="light" />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={COLORS.primary}
            colors={[COLORS.primary]}
          />
        }
      >
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Panel de Control</Text>
          <Text style={styles.headerSubtitle}>Sistema de Vigilancia IoT</Text>
        </View>

        {/* Error */}
        {error && (
          <View style={styles.errorCard}>
            <Ionicons name="cloud-offline-outline" size={24} color={COLORS.danger} />
            <View style={{ flex: 1, marginLeft: SPACING.md }}>
              <Text style={styles.errorTitle}>Sin conexión al backend</Text>
              <Text style={styles.errorMsg}>{error}</Text>
              <Text style={styles.errorHint}>
                Verifica que el backend esté corriendo en{"\n"}
                {CONFIG.BACKEND_URL}
              </Text>
            </View>
          </View>
        )}

        {status && (
          <>
            {/* ---- Tarjeta: Estado General ---- */}
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <Ionicons name="pulse-outline" size={20} color={COLORS.primary} />
                <Text style={styles.cardTitle}>Estado General</Text>
              </View>

              <View style={styles.statusGrid}>
                <StatusItem
                  icon="server-outline"
                  label="Backend"
                  value={status.backend === "online" ? "En línea" : "Offline"}
                  color={status.backend === "online" ? COLORS.success : COLORS.danger}
                />
                <StatusItem
                  icon={status.detection_active ? "lock-closed-outline" : "lock-open-outline"}
                  label="Modo Fuera de casa"
                  value={status.detection_active ? "Armado" : "Desarmado"}
                  color={status.detection_active ? COLORS.danger : COLORS.success}
                />
                <StatusItem
                  icon="time-outline"
                  label="Cooldown"
                  value={status.cooldown_active ? "Activo" : "Listo"}
                  color={status.cooldown_active ? COLORS.warning : COLORS.success}
                />
                <StatusItem
                  icon="image-outline"
                  label="Frame Ref."
                  value={status.has_reference_frame ? "Sí" : "No"}
                  color={status.has_reference_frame ? COLORS.success : COLORS.textMuted}
                />
              </View>
            </View>

            {/* ---- Tarjeta: Estadísticas ---- */}
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <Ionicons name="stats-chart-outline" size={20} color={COLORS.info} />
                <Text style={styles.cardTitle}>Estadísticas</Text>
              </View>

              <View style={styles.statsGrid}>
                <BigStat
                  value={status.total_analyses.toString()}
                  label="Análisis"
                  icon="analytics-outline"
                  color={COLORS.primary}
                />
                <BigStat
                  value={status.total_detections.toString()}
                  label="Intrusiones"
                  icon="alert-circle-outline"
                  color={COLORS.danger}
                />
                <BigStat
                  value={`${status.last_diff_pct.toFixed(1)}%`}
                  label="Último cambio"
                  icon="git-compare-outline"
                  color={COLORS.warning}
                />
              </View>
            </View>

            {/* ---- Tarjeta: Horario ---- */}
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <Ionicons name="calendar-outline" size={20} color={COLORS.warning} />
                <Text style={styles.cardTitle}>Franja Horaria</Text>
              </View>

              <View style={styles.scheduleRow}>
                <View style={styles.scheduleTime}>
                  <Text style={styles.scheduleLabel}>Inicio</Text>
                  <Text style={styles.scheduleValue}>{status.schedule.start}</Text>
                </View>
                <Ionicons name="arrow-forward" size={20} color={COLORS.textMuted} />
                <View style={styles.scheduleTime}>
                  <Text style={styles.scheduleLabel}>Fin</Text>
                  <Text style={styles.scheduleValue}>{status.schedule.end}</Text>
                </View>
              </View>

              <View
                style={[
                  styles.scheduleBadge,
                  status.schedule.currently_active
                    ? styles.scheduleBadgeActive
                    : styles.scheduleBadgeInactive,
                ]}
              >
                <Ionicons
                  name={status.schedule.currently_active ? "checkmark-circle" : "close-circle"}
                  size={16}
                  color={status.schedule.currently_active ? COLORS.success : COLORS.warning}
                />
                <Text
                  style={[
                    styles.scheduleBadgeText,
                    {
                      color: status.schedule.currently_active ? COLORS.success : COLORS.warning,
                    },
                  ]}
                >
                  {status.schedule.currently_active
                    ? "Dentro de la franja de vigilancia"
                    : "Fuera de la franja de vigilancia"}
                </Text>
              </View>
            </View>

            {/* ---- Tarjeta: ESP32 ---- */}
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <Ionicons name="hardware-chip-outline" size={20} color={COLORS.success} />
                <Text style={styles.cardTitle}>ESP32 Actuador</Text>
              </View>

              <View style={styles.esp32Row}>
                <Text style={styles.esp32Label}>IP del dispositivo</Text>
                <Text style={styles.esp32Value}>{status.esp32_ip}</Text>
              </View>

              {status.last_alert && (
                <View style={styles.esp32Row}>
                  <Text style={styles.esp32Label}>Última alerta</Text>
                  <Text style={styles.esp32Value}>
                    {new Date(status.last_alert).toLocaleString("es-CO")}
                  </Text>
                </View>
              )}
            </View>
          </>
        )}

        {/* Espacio inferior */}
        <View style={{ height: 32 }} />
      </ScrollView>
    </View>
  );
}

// ---- Componentes auxiliares ----

function StatusItem({
  icon,
  label,
  value,
  color,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string;
  color: string;
}) {
  return (
    <View style={styles.statusItem}>
      <View style={[styles.statusDot, { backgroundColor: color }]} />
      <View>
        <Text style={styles.statusLabel}>{label}</Text>
        <Text style={[styles.statusValue, { color }]}>{value}</Text>
      </View>
    </View>
  );
}

function BigStat({
  value,
  label,
  icon,
  color,
}: {
  value: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
}) {
  return (
    <View style={styles.bigStat}>
      <View style={[styles.bigStatIcon, { backgroundColor: `${color}20` }]}>
        <Ionicons name={icon} size={22} color={color} />
      </View>
      <Text style={styles.bigStatValue}>{value}</Text>
      <Text style={styles.bigStatLabel}>{label}</Text>
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
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: SPACING.xl,
    paddingTop: 56,
  },

  // ---- Header ----
  header: {
    marginBottom: SPACING.xxl,
  },
  headerTitle: {
    color: COLORS.textPrimary,
    fontSize: FONT.title,
    fontWeight: FONT.bold,
  },
  headerSubtitle: {
    color: COLORS.textSecondary,
    fontSize: FONT.md,
    marginTop: SPACING.xs,
  },

  // ---- Error ----
  errorCard: {
    flexDirection: "row",
    backgroundColor: COLORS.dangerBg,
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.2)",
    borderRadius: RADIUS.lg,
    padding: SPACING.lg,
    marginBottom: SPACING.xl,
    alignItems: "flex-start",
  },
  errorTitle: {
    color: COLORS.danger,
    fontSize: FONT.md,
    fontWeight: FONT.bold,
    marginBottom: SPACING.xs,
  },
  errorMsg: {
    color: COLORS.danger,
    fontSize: FONT.sm,
    opacity: 0.8,
  },
  errorHint: {
    color: COLORS.textMuted,
    fontSize: FONT.xs,
    marginTop: SPACING.sm,
  },

  // ---- Cards ----
  card: {
    backgroundColor: COLORS.bgCard,
    borderRadius: RADIUS.lg,
    padding: SPACING.lg,
    marginBottom: SPACING.lg,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: SPACING.lg,
    gap: SPACING.sm,
  },
  cardTitle: {
    color: COLORS.textPrimary,
    fontSize: FONT.lg,
    fontWeight: FONT.semibold,
  },

  // ---- Status Grid ----
  statusGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: SPACING.md,
  },
  statusItem: {
    flexDirection: "row",
    alignItems: "center",
    width: "45%",
    gap: SPACING.sm,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusLabel: {
    color: COLORS.textMuted,
    fontSize: FONT.xs,
  },
  statusValue: {
    fontSize: FONT.sm,
    fontWeight: FONT.semibold,
  },

  // ---- Stats Grid ----
  statsGrid: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  bigStat: {
    alignItems: "center",
    flex: 1,
  },
  bigStatIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: SPACING.sm,
  },
  bigStatValue: {
    color: COLORS.textPrimary,
    fontSize: FONT.xl,
    fontWeight: FONT.bold,
  },
  bigStatLabel: {
    color: COLORS.textMuted,
    fontSize: FONT.xs,
    marginTop: 2,
  },

  // ---- Schedule ----
  scheduleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: SPACING.xl,
    marginBottom: SPACING.lg,
  },
  scheduleTime: {
    alignItems: "center",
  },
  scheduleLabel: {
    color: COLORS.textMuted,
    fontSize: FONT.xs,
    marginBottom: 2,
  },
  scheduleValue: {
    color: COLORS.textPrimary,
    fontSize: FONT.xxl,
    fontWeight: FONT.bold,
  },
  scheduleBadge: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: SPACING.sm,
    borderRadius: RADIUS.sm,
    gap: SPACING.xs,
  },
  scheduleBadgeActive: {
    backgroundColor: COLORS.successBg,
  },
  scheduleBadgeInactive: {
    backgroundColor: COLORS.warningBg,
  },
  scheduleBadgeText: {
    fontSize: FONT.sm,
    fontWeight: FONT.medium,
  },

  // ---- ESP32 ----
  esp32Row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  esp32Label: {
    color: COLORS.textSecondary,
    fontSize: FONT.sm,
  },
  esp32Value: {
    color: COLORS.textPrimary,
    fontSize: FONT.sm,
    fontWeight: FONT.medium,
  },
});
