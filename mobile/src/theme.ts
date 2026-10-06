// ============================================================
// THEME — Colores y estilos compartidos
// ============================================================

export const COLORS = {
  // Fondo principal (dark mode)
  bg: "#0A0E17",
  bgCard: "#111827",
  bgCardLight: "#1A2235",
  bgAccent: "#162033",

  // Texto
  textPrimary: "#F1F5F9",
  textSecondary: "#94A3B8",
  textMuted: "#64748B",

  // Acentos
  primary: "#3B82F6",       // Azul principal
  primaryDark: "#2563EB",
  primaryLight: "#60A5FA",

  success: "#22C55E",
  successDark: "#16A34A",
  successBg: "rgba(34, 197, 94, 0.15)",

  danger: "#EF4444",
  dangerDark: "#DC2626",
  dangerBg: "rgba(239, 68, 68, 0.15)",

  warning: "#F59E0B",
  warningBg: "rgba(245, 158, 11, 0.15)",

  info: "#06B6D4",
  infoBg: "rgba(6, 182, 212, 0.15)",

  // Bordes
  border: "#1E293B",
  borderLight: "#334155",
};

export const SPACING = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
};

export const RADIUS = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  full: 999,
};

export const FONT = {
  // Tamaños
  xs: 11,
  sm: 13,
  md: 15,
  lg: 17,
  xl: 20,
  xxl: 24,
  title: 28,

  // Weights
  regular: "400" as const,
  medium: "500" as const,
  semibold: "600" as const,
  bold: "700" as const,
};
