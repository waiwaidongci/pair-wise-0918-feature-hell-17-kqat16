// 潜水店充填台 —— 领域模型

export type EquipmentKind = "compressor" | "fillPump";

export type EquipmentRuntimeStatus = "idle" | "running" | "paused" | "maintenance";

/** 维护锁窗口：开始时登记计划结束时间，结束时回填实际结束时间 */
export interface MaintenanceWindow {
  reason: string;
  start: number;
  plannedEnd: number;
  actualEnd: number | null;
}

export interface Equipment {
  id: string;
  name: string;
  kind: EquipmentKind;
  maintenance: MaintenanceWindow | null;
}

export type FillMode = "air" | "nitrox" | "trimix";

export type OrderStatus =
  | "confirmed" // 已确认排班、尚未开始充填
  | "inProgress" // 充填进行中
  | "paused" // 因设备维护暂停、现场保留
  | "completed" // 充填完成、待签收
  | "signed" // 已签收
  | "cancelled";

export interface TankSpec {
  tankNo: string;
  volumeL: number;
  inspectionExpiry: string; // ISO 日期 yyyy-mm-dd
  residualBar: number;
  targetBar: number;
  oxygenPct: number; // %
  heliumPct: number; // %
}

/**
 * 客户确认信息。
 * firstConfirmed* 为首次确认时的不可变快照：改约满两次后，
 * 当前联系方式必须与快照保持一致（沿用首次确认信息）。
 */
export interface CustomerConfirm {
  customerName: string;
  contact: string;
  confirmedAt: number;
  firstConfirmedName: string;
  firstConfirmedContact: string;
}

/** 一次维护暂停记录：恢复后计算暂停时长 */
export interface PauseRecord {
  equipmentId: string;
  reason: string;
  maintenanceStart: number;
  pausedAt: number;
  resumedAt: number | null;
  maintenanceEnd: number | null;
  durationMs: number | null;
  pressureAtPauseBar: number;
}

export interface ProgressPoint {
  t: number;
  pressureBar: number;
  note: string;
}

export type OrderEventType =
  | "created"
  | "customerConfirmed"
  | "rescheduled"
  | "fillStarted"
  | "pressureLogged"
  | "maintenancePaused"
  | "maintenanceResumed"
  | "fillCompleted"
  | "signed"
  | "cancelled";

export interface OrderEvent {
  id: string;
  t: number;
  type: OrderEventType;
  detail: string;
  /** 本次事件是否产生一次改约计数（维护超时顺延为 0） */
  rescheduleDelta?: number;
}

export interface Order {
  id: string;
  no: string;
  equipmentId: string;
  fillMode: FillMode;
  operator: string;
  tank: TankSpec;
  scheduledStart: number;
  scheduledDurationMin: number;
  status: OrderStatus;
  startedAt: number | null;
  completedAt: number | null;
  signedAt: number | null;
  currentPressureBar: number;
  progressLog: ProgressPoint[];
  customer: CustomerConfirm | null;
  /** 全部原因导致的改约次数（维护自动改约 + 客户改约 + 超时顺延为 0） */
  rescheduleCount: number;
  /** 仅客户发起的改约次数；满 2 次后强制沿用首次确认信息 */
  customerRescheduleCount: number;
  lastRescheduleReason: string | null;
  pauseHistory: PauseRecord[];
  activePause: PauseRecord | null;
  events: OrderEvent[];
  createdAt: number;
}

export interface AuditEntry {
  id: string;
  t: number;
  level: "info" | "warn";
  text: string;
}

export interface State {
  version: 1;
  equipments: Equipment[];
  orders: Order[];
  audit: AuditEntry[];
  seededAt: number;
}
