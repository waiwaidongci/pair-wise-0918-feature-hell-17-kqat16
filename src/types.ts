// 潜水店充填台 —— 领域模型定义

export type EquipmentKind = "compressor" | "fillpump";

/** 设备实时状态由数据派生：维护锁优先，其次有在职工单，否则空闲 */
export type EquipmentStatus = "idle" | "filling" | "maintenance";

export interface Equipment {
  id: string;
  name: string;
  kind: EquipmentKind;
  model: string;
}

export interface MaintenanceWindow {
  id: string;
  equipmentId: string;
  reason: string;
  start: number; // 维护开始（上锁）时间
  expectedEnd: number; // 预计解锁时间，用于改约排程
  end: number | null; // 实际解锁时间，null = 维护中
  pausedOrderIds: string[]; // 维护开始时被暂停的在职工单
  rescheduledOrderIds: string[]; // 本次维护导致改约的工单
  resumedOrderIds: string[]; // 维护结束后恢复的工单
}

export type FillMethod = "空气" | "高氧" | "Trimix";

export type OrderStatus =
  | "scheduled" // 已排期，未开始充填
  | "filling" // 充填进行中
  | "paused" // 维护锁暂停中，保留现场
  | "completed" // 充填完成，待签收 / 已签收
  | "cancelled";

/** 客户首次确认的信息快照，改约两次后仍沿用 */
export interface ConfirmInfo {
  contactName: string;
  phone: string;
  fillMethod: FillMethod;
  targetPressure: number;
  o2: number;
  he: number;
  operator: string;
  note: string;
  frozenAt: number;
}

export interface OrderEvent {
  id: string;
  t: number;
  kind:
    | "created"
    | "rescheduled"
    | "started"
    | "paused"
    | "resumed"
    | "completed"
    | "signed"
    | "cancelled";
  message: string;
}

export interface Order {
  id: string;
  code: string;
  tankNo: string;
  volume: string;
  inspectionExpiry: number;
  residualPressure: number;
  targetPressure: number;
  o2: number; // 氧含量 %
  he: number; // 氦含量 %
  fillMethod: FillMethod;
  operator: string;
  contactName: string;
  phone: string;
  equipmentId: string;
  start: number; // 排班时段起
  end: number; // 排班时段止（恢复后会顺延暂停时长）
  durationMin: number;
  status: OrderStatus;
  actualStart: number | null;
  completedAt: number | null;
  signedBy: string | null;
  signedAt: number | null;
  cancelledAt: number | null;
  // 进度计量：progressBase 为进入当前充填段前已完成比例，progressSince 为本段起算时间
  progressBase: number;
  progressSince: number | null;
  pausedAt: number | null;
  resumedAt: number | null;
  totalPauseMs: number;
  pauseMinutes: number; // 最近一次（或累计）暂停时长，分钟
  maintenanceId: string | null; // 当前/最近一次暂停所属维护
  rescheduleCount: number;
  confirmedInfo: ConfirmInfo;
  rescheduleLocked: boolean; // 改约已达两次，沿用首次确认信息
  events: OrderEvent[];
}

export interface GlobalEvent {
  id: string;
  t: number;
  category: "order" | "maintenance" | "system";
  message: string;
  orderId?: string;
  equipmentId?: string;
}

export interface AppState {
  now: number;
  equipment: Equipment[];
  orders: Order[];
  maintenance: MaintenanceWindow[];
  log: GlobalEvent[];
}
