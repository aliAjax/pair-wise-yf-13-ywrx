// 巡检路线签点闭环：领域模型、固定班次/路线、校验与本地数据同步
// 不依赖任何外部服务，全部状态保存在浏览器 localStorage。

export type DeviceId = "main" | "gen" | "pump" | "bilge";

export interface ReadingField {
  key: string;
  label: string;
  unit: string;
  min: number;
  max: number;
}

export interface DeviceDef {
  id: DeviceId;
  /** 路线与看板上显示的完整设备名 */
  name: string;
  /** 筛选标签用短名 */
  shortName: string;
  /** 是否要求设备处于启动运行状态方可签点（舱底水无此项） */
  requiresRunning: boolean;
  fields: ReadingField[];
}

/** 每班固定巡检序列：主机 → 发电机 → 泵组 → 舱底水 */
export const ROUTE: DeviceDef[] = [
  {
    id: "main",
    name: "主机",
    shortName: "主机",
    requiresRunning: true,
    fields: [
      { key: "rpm", label: "主机转速", unit: "rpm", min: 60, max: 110 },
      { key: "oil", label: "滑油压力", unit: "MPa", min: 0.3, max: 0.55 },
      { key: "cool", label: "冷却水温", unit: "℃", min: 65, max: 85 },
      { key: "fuel", label: "燃油消耗", unit: "L", min: 0, max: 600 },
    ],
  },
  {
    id: "gen",
    name: "发电机#2",
    shortName: "发电机",
    requiresRunning: true,
    fields: [
      { key: "volt", label: "输出电压", unit: "V", min: 380, max: 420 },
      { key: "freq", label: "频率", unit: "Hz", min: 49.5, max: 50.5 },
      { key: "cool", label: "冷却水温", unit: "℃", min: 55, max: 80 },
    ],
  },
  {
    id: "pump",
    name: "泵组#1",
    shortName: "泵组",
    requiresRunning: true,
    fields: [
      { key: "press", label: "出口压力", unit: "MPa", min: 0.2, max: 0.5 },
      { key: "flow", label: "流量", unit: "m³/h", min: 10, max: 40 },
    ],
  },
  {
    id: "bilge",
    name: "舱底水",
    shortName: "舱底水",
    requiresRunning: false,
    fields: [
      { key: "level", label: "舱底水位", unit: "m", min: 0, max: 1.8 },
      { key: "temp", label: "舱底水温", unit: "℃", min: 5, max: 45 },
    ],
  },
];

/** 三班轮值制下的 6 个固定班次 */
export const WATCHES = [
  "00-04班",
  "04-08班",
  "08-12班",
  "12-16班",
  "16-20班",
  "20-24班",
] as const;

export interface Signoff {
  deviceId: DeviceId;
  readings: Record<string, number>;
  running: boolean;
  operator: string;
  time: string;
}

export type MissStatus = "pending" | "approved" | "rejected";

export interface MissEntry {
  id: string;
  deviceId: DeviceId;
  reason: string;
  operator: string;
  time: string;
  status: MissStatus;
  reviewer?: string;
  reviewedAt?: string;
}

export type EventKind =
  | "reject"
  | "miss"
  | "review-approve"
  | "review-reject"
  | "miss-resubmit"
  | "handover";

export interface TimelineEvent {
  id: string;
  deviceId: DeviceId | "system";
  kind: EventKind;
  detail: string;
  operator: string;
  time: string;
}

export interface ShiftState {
  /** 每台设备每班至多一条签点 */
  signoffs: Partial<Record<DeviceId, Signoff>>;
  /** 漏检记录（同一设备同班次至多一条） */
  misses: MissEntry[];
  events: TimelineEvent[];
  handoverNote: string;
  handedOver: boolean;
  handedOverAt?: string;
  handoverOperator?: string;
  handoverReviewer?: string;
}

export interface RootState {
  version: 1;
  date: string;
  watch: string;
  operator: string;
  reviewer: string;
  shifts: Record<string, ShiftState>;
}

export const STORAGE_KEY = "marine-watch-state-v1";

export function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function defaultWatch(now = new Date()): string {
  return WATCHES[Math.min(WATCHES.length - 1, Math.floor(now.getHours() / 4))];
}

export function shiftKey(date: string, watch: string): string {
  return `${date}|${watch}`;
}

export function emptyShift(): ShiftState {
  return {
    signoffs: {},
    misses: [],
    events: [],
    handoverNote: "",
    handedOver: false,
  };
}

export function defaultRoot(): RootState {
  const date = todayLocal();
  const watch = defaultWatch();
  return {
    version: 1,
    date,
    watch,
    operator: "",
    reviewer: "",
    shifts: { [shiftKey(date, watch)]: emptyShift() },
  };
}

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(
    d.getHours()
  )}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function deviceName(id: DeviceId | "system"): string {
  if (id === "system") return "值班交接";
  return ROUTE.find((d) => d.id === id)?.name ?? id;
}

/**
 * 签点前置校验：读数缺失/非数字/越界，或需运行确认的设备未启动，
 * 均返回拒绝原因；返回 null 表示通过。
 */
export function validateSignoff(
  device: DeviceDef,
  form: Record<string, string>,
  running: boolean
): string | null {
  for (const f of device.fields) {
    const raw = (form[f.key] ?? "").trim();
    if (raw === "") return `${f.label}未填写，本次签点拒绝`;
    const v = Number(raw);
    if (!Number.isFinite(v)) return `${f.label}必须为数字，本次签点拒绝`;
    if (v < f.min || v > f.max) {
      return `${f.label}读数越界：${v}${f.unit}，允许范围 ${f.min}~${f.max}${f.unit}，整次拒绝`;
    }
  }
  if (device.requiresRunning && !running) {
    return "设备未启动，禁止签点，整次拒绝";
  }
  return null;
}

export function summarizeReadings(
  device: DeviceDef,
  readings: Record<string, number>
): string {
  return device.fields
    .map((f) => `${f.label} ${readings[f.key]}${f.unit}`)
    .join("，");
}

export const MISS_STATUS_LABEL: Record<MissStatus, string> = {
  pending: "待交班复核",
  approved: "复核通过",
  rejected: "复核驳回",
};

export const EVENT_META: Record<
  EventKind,
  { label: string; tone: "danger" | "warn" | "ok" | "info" }
> = {
  reject: { label: "签点拒绝", tone: "danger" },
  miss: { label: "漏检登记", tone: "warn" },
  "review-approve": { label: "复核通过", tone: "ok" },
  "review-reject": { label: "复核驳回", tone: "danger" },
  "miss-resubmit": { label: "重新提交", tone: "info" },
  handover: { label: "交接完成", tone: "ok" },
};

/** 本地数据同步：读取失败或版本不符时回落到全新状态 */
export function loadState(): RootState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultRoot();
    const parsed = JSON.parse(raw) as RootState;
    if (
      !parsed ||
      parsed.version !== 1 ||
      typeof parsed.date !== "string" ||
      typeof parsed.watch !== "string" ||
      typeof parsed.shifts !== "object" ||
      parsed.shifts === null
    ) {
      return defaultRoot();
    }
    return {
      version: 1,
      date: parsed.date,
      watch: parsed.watch,
      operator: typeof parsed.operator === "string" ? parsed.operator : "",
      reviewer: typeof parsed.reviewer === "string" ? parsed.reviewer : "",
      shifts: parsed.shifts,
    };
  } catch {
    return defaultRoot();
  }
}
