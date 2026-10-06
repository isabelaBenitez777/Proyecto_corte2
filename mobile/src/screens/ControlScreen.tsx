// ============================================================
// PANTALLA: CONTROL (Configuración y acciones)
// ============================================================
// Permite al usuario controlar la alarma, horario y detección.

import React, { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Alert,
  Switch,
  ActivityIndicator,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { StatusBar } from "expo-status-bar";

import { CONFIG } from "../config";
import { COLORS, SPACING, RADIUS, FONT } from "../theme";
import {
  getBackendStatus,
  enableDetection,
  disableDetection,
  triggerAlarm,
  silenceAlarm,
  setSchedule,
  resetReference,
  getAlertEmail,
  setAlertEmail,
  testAlertEmail,
} from "../services/api";

export default function ControlScreen() {
  const [detectionActive, setDetectionActive] = useState(true);
  const [scheduleStart, setScheduleStart] = useState("00:00");
  const [scheduleEnd, setScheduleEnd] = useState("23:59");
  const [alertEmail, setAlertEmailState] = useState("");
  const [loading, setLoading] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  // ---- Cargar estado actual ----
  const loadStatus = useCallback(async () => {
    try {
      const st = await getBackendStatus();
      setDetectionActive(st.detection_active);
      setScheduleStart(st.schedule.start);
      setScheduleEnd(st.schedule.end);
      setConnected(true);

      const emailData = await getAlertEmail();
      setAlertEmailState(emailData.email);
    } catch {
      setConnected(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
    const id = setInterval(async () => {
      try {
        await getBackendStatus();
        setConnected(true);
      } catch {
        setConnected(false);
      }
    }, 3000);
    return () => clearInterval(id);
  }, [loadStatus]);

  // ---- Acciones ----
  const handleToggleDetection = async (value: boolean) => {
    setDetectionActive(value);
    setLoading("detection");
    try {
      if (value) {
        await enableDetection();
      } else {
        await disableDetection();
      }
    } catch (e: any) {
      Alert.alert("Error", e.message);
      setDetectionActive(!value);
    }
    setLoading(null);
  };

  const handleTriggerAlarm = async () => {
    setLoading("alarm-on");
    try {
      const result = await triggerAlarm();
      Alert.alert(
        "Alarma",
        result.esp32_reached
          ? "🚨 Alarma activada en el ESP32"
          : "⚠ Alarma enviada pero el ESP32 no respondió"
      );
    } catch (e: any) {
      Alert.alert("Error", e.message);
    }
    setLoading(null);
  };

  const handleSilenceAlarm = async () => {
    setLoading("alarm-off");
    try {
      await silenceAlarm();
      Alert.alert("Alarma", "🔇 Alarma silenciada");
    } catch (e: any) {
      Alert.alert("Error", e.message);
    }
    setLoading(null);
  };

  const handleSetSchedule = async () => {
    // Validar formato HH:MM
    const timeRegex = /^\d{2}:\d{2}$/;
    if (!timeRegex.test(scheduleStart) || !timeRegex.test(scheduleEnd)) {
      Alert.alert("Error", "Formato inválido. Usa HH:MM (ej: 22:00)");
      return;
    }

    setLoading("schedule");
    try {
      await setSchedule(scheduleStart, scheduleEnd);
      Alert.alert("Horario", `✅ Horario actualizado: ${scheduleStart} — ${scheduleEnd}`);
    } catch (e: any) {
      Alert.alert("Error", e.message);
    }
    setLoading(null);
  };

  const handleResetReference = async () => {
    Alert.alert(
      "Resetear Referencia",
      "¿Resetear el frame de referencia? La próxima imagen será la nueva base para comparación.",
      [
        { text: "Cancelar", style: "cancel" },
        {
          text: "Resetear",
          style: "destructive",
          onPress: async () => {
            setLoading("reset");
            try {
              await resetReference();
              Alert.alert("Listo", "🔄 Frame de referencia reseteado");
            } catch (e: any) {
              Alert.alert("Error", e.message);
            }
            setLoading(null);
          },
        },
      ]
    );
  };

  const handleSaveEmail = async () => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(alertEmail)) {
      Alert.alert("Error", "Ingresa un correo válido");
      return;
    }
    setLoading("email");
    try {
      await setAlertEmail(alertEmail);
      Alert.alert("Éxito", "✅ Correo de alertas actualizado");
    } catch (e: any) {
      Alert.alert("Error", e.message);
    }
    setLoading(null);
  };

  const handleTestEmail = async () => {
    setLoading("test-email");
    try {
      await testAlertEmail();
      Alert.alert("Prueba enviada", "Se ha enviado un correo de prueba al destino configurado.\n\nSi no llega, revisa la terminal del backend para ver errores (ej. contraseña incorrecta).");
    } catch (e: any) {
      Alert.alert("Error de Envío", e.message);
    }
    setLoading(null);
  };

  return (
    <View style={styles.container}>
      <StatusBar style="light" />
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Control</Text>
          <View style={styles.connBadge}>
            <View
              style={[
                styles.connDot,
                { backgroundColor: connected ? COLORS.success : COLORS.danger },
              ]}
            />
            <Text style={styles.connText}>
              {connected ? "Conectado" : "Desconectado"}
            </Text>
          </View>
        </View>

        {/* ==== SECCIÓN: Detección (Armar/Desarmar) ==== */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Ionicons name={detectionActive ? "lock-closed-outline" : "lock-open-outline"} size={20} color={detectionActive ? COLORS.danger : COLORS.success} />
            <Text style={styles.cardTitle}>Modo "Fuera de casa"</Text>
          </View>

          <View style={styles.switchRow}>
            <View style={{ flex: 1, marginRight: 12 }}>
              <Text style={styles.switchLabel}>{detectionActive ? "Armado" : "Desarmado"}</Text>
              <Text style={styles.switchDesc}>
                {detectionActive
                  ? "Cámara activa: Se disparará alarma y correos al detectar movimiento."
                  : "Cámara inactiva: El sistema está pausado y seguro."}
              </Text>
            </View>
            <Switch
              value={detectionActive}
              onValueChange={handleToggleDetection}
              trackColor={{ false: COLORS.bgAccent, true: COLORS.danger + "80" }}
              thumbColor={detectionActive ? COLORS.danger : COLORS.textMuted}
              disabled={loading === "detection"}
            />
          </View>
        </View>

        {/* ==== SECCIÓN: Horario ==== */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Ionicons name="time-outline" size={20} color={COLORS.warning} />
            <Text style={styles.cardTitle}>Franja Horaria</Text>
          </View>

          <Text style={styles.fieldLabel}>
            Solo se disparan alarmas dentro de esta franja:
          </Text>

          <View style={styles.timeRow}>
            <View style={styles.timeField}>
              <Text style={styles.timeFieldLabel}>Inicio</Text>
              <TextInput
                style={styles.timeInput}
                value={scheduleStart}
                onChangeText={setScheduleStart}
                placeholder="HH:MM"
                placeholderTextColor={COLORS.textMuted}
                keyboardType="numbers-and-punctuation"
                maxLength={5}
              />
            </View>
            <Ionicons
              name="arrow-forward"
              size={18}
              color={COLORS.textMuted}
              style={{ marginTop: 24 }}
            />
            <View style={styles.timeField}>
              <Text style={styles.timeFieldLabel}>Fin</Text>
              <TextInput
                style={styles.timeInput}
                value={scheduleEnd}
                onChangeText={setScheduleEnd}
                placeholder="HH:MM"
                placeholderTextColor={COLORS.textMuted}
                keyboardType="numbers-and-punctuation"
                maxLength={5}
              />
            </View>
          </View>

          <TouchableOpacity
            style={styles.saveBtn}
            onPress={handleSetSchedule}
            disabled={loading === "schedule"}
          >
            {loading === "schedule" ? (
              <ActivityIndicator color="#FFF" size="small" />
            ) : (
              <>
                <Ionicons name="save-outline" size={18} color="#FFF" />
                <Text style={styles.saveBtnText}>Guardar Horario</Text>
              </>
            )}
          </TouchableOpacity>
        </View>

        {/* ==== SECCIÓN: Correo de Alertas ==== */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Ionicons name="mail-outline" size={20} color={COLORS.info} />
            <Text style={styles.cardTitle}>Destino de Alertas</Text>
          </View>

          <Text style={styles.fieldLabel}>
            Correo al que llegarán las notificaciones con foto:
          </Text>

          <TextInput
            style={[styles.timeInput, { fontSize: FONT.md, textAlign: "left", paddingHorizontal: 16, marginBottom: 12 }]}
            value={alertEmail}
            onChangeText={setAlertEmailState}
            placeholder="ejemplo@correo.com"
            placeholderTextColor={COLORS.textMuted}
            keyboardType="email-address"
            autoCapitalize="none"
          />

          <View style={{ flexDirection: "row", gap: 10 }}>
            <TouchableOpacity
              style={[styles.saveBtn, { flex: 1, backgroundColor: COLORS.bgAccent, borderWidth: 1, borderColor: COLORS.primary }]}
              onPress={handleTestEmail}
              disabled={loading === "test-email"}
            >
              {loading === "test-email" ? (
                <ActivityIndicator color={COLORS.primary} size="small" />
              ) : (
                <Text style={[styles.saveBtnText, { color: COLORS.primary }]}>Probar</Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.saveBtn, { flex: 1 }]}
              onPress={handleSaveEmail}
              disabled={loading === "email"}
            >
              {loading === "email" ? (
                <ActivityIndicator color="#FFF" size="small" />
              ) : (
                <Text style={styles.saveBtnText}>Guardar Correo</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>

        {/* ==== SECCIÓN: Mantenimiento ==== */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Ionicons name="construct-outline" size={20} color={COLORS.textSecondary} />
            <Text style={styles.cardTitle}>Mantenimiento</Text>
          </View>

          <TouchableOpacity
            style={styles.maintBtn}
            onPress={handleResetReference}
            disabled={loading === "reset"}
          >
            <Ionicons name="refresh-circle-outline" size={22} color={COLORS.primary} />
            <View style={{ flex: 1 }}>
              <Text style={styles.maintBtnTitle}>Resetear Frame de Referencia</Text>
              <Text style={styles.maintBtnDesc}>
                Útil si cambió la posición de la cámara o la iluminación
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={COLORS.textMuted} />
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.maintBtn}
            onPress={loadStatus}
          >
            <Ionicons name="sync-outline" size={22} color={COLORS.info} />
            <View style={{ flex: 1 }}>
              <Text style={styles.maintBtnTitle}>Sincronizar Estado</Text>
              <Text style={styles.maintBtnDesc}>
                Volver a cargar la configuración del backend
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={COLORS.textMuted} />
          </TouchableOpacity>
        </View>

        {/* ---- Info del backend ---- */}
        <View style={styles.infoBox}>
          <Ionicons name="information-circle-outline" size={16} color={COLORS.textMuted} />
          <Text style={styles.infoText}>Backend: {CONFIG.BACKEND_URL}</Text>
        </View>

        <View style={{ height: 32 }} />
      </ScrollView>
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
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: SPACING.xxl,
  },
  headerTitle: {
    color: COLORS.textPrimary,
    fontSize: FONT.title,
    fontWeight: FONT.bold,
  },
  connBadge: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: COLORS.bgCard,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
    borderRadius: RADIUS.full,
    gap: SPACING.xs,
  },
  connDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  connText: {
    color: COLORS.textSecondary,
    fontSize: FONT.xs,
    fontWeight: FONT.medium,
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

  // ---- Switch ----
  switchRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  switchLabel: {
    color: COLORS.textPrimary,
    fontSize: FONT.md,
    fontWeight: FONT.medium,
  },
  switchDesc: {
    color: COLORS.textMuted,
    fontSize: FONT.sm,
    marginTop: 2,
  },

  // ---- Action Buttons ----
  btnGrid: {
    flexDirection: "row",
    gap: SPACING.md,
  },
  actionBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: SPACING.lg,
    borderRadius: RADIUS.md,
    gap: SPACING.sm,
  },
  dangerBtn: {
    backgroundColor: COLORS.danger,
  },
  successBtn: {
    backgroundColor: COLORS.successDark,
  },
  actionBtnText: {
    color: "#FFF",
    fontSize: FONT.sm,
    fontWeight: FONT.bold,
    textAlign: "center",
  },

  // ---- Schedule ----
  fieldLabel: {
    color: COLORS.textSecondary,
    fontSize: FONT.sm,
    marginBottom: SPACING.md,
  },
  timeRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: SPACING.lg,
    marginBottom: SPACING.lg,
  },
  timeField: {
    flex: 1,
  },
  timeFieldLabel: {
    color: COLORS.textMuted,
    fontSize: FONT.xs,
    marginBottom: SPACING.xs,
  },
  timeInput: {
    backgroundColor: COLORS.bgAccent,
    color: COLORS.textPrimary,
    fontSize: FONT.xl,
    fontWeight: FONT.bold,
    textAlign: "center",
    paddingVertical: SPACING.md,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  saveBtn: {
    flexDirection: "row",
    backgroundColor: COLORS.primary,
    paddingVertical: SPACING.md,
    borderRadius: RADIUS.md,
    justifyContent: "center",
    alignItems: "center",
    gap: SPACING.sm,
  },
  saveBtnText: {
    color: "#FFF",
    fontSize: FONT.md,
    fontWeight: FONT.bold,
  },
  secondaryBtn: {
    backgroundColor: COLORS.bgAccent,
    borderWidth: 1,
    borderColor: COLORS.primary,
  },

  // ---- Maintenance ----
  maintBtn: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: SPACING.md,
    gap: SPACING.md,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  maintBtnTitle: {
    color: COLORS.textPrimary,
    fontSize: FONT.md,
    fontWeight: FONT.medium,
  },
  maintBtnDesc: {
    color: COLORS.textMuted,
    fontSize: FONT.xs,
    marginTop: 2,
  },

  // ---- Info ----
  infoBox: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: SPACING.xs,
    marginTop: SPACING.sm,
  },
  infoText: {
    color: COLORS.textMuted,
    fontSize: FONT.xs,
  },
});
