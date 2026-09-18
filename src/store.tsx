import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from "react";
import type {
  AppState,
  ConfirmInfo,
  Equipment,
  FillMethod,
  GlobalEvent,
  Order,
  OrderEvent,
} from "./types";
import {
  findNearestSlot,
  roundUpStep,
  slotHasConflict,
} from "./scheduling";

const STORAGE_KEY = "dive-fill-maintenance-lock-v1";
const DAY_MS = 86_400_000;
const MIN_MS = 60_000;

let counter = 0;
function uid(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}`;
}

export function fmtTimeShort(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtDuration(ms: number): string {
  const mins = Math.round(ms / MIN_MS);
  if (mins < 60) return `${mins} 分钟`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`;
}

export function toLocalInputValue(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(
    d.getHours()
  )}:${p(d.getMinutes())}`;
}

export function inspectionStatus(
  expiry: number,
  now: number
): "expired" | "warning" | "ok" {
  const days = (expiry - now) / DAY_MS;
  if (days < 0) return "expired";
  if (days <= 30) return "warning";
  return "ok";
}

/** 混合气比例提示：返回氮气余量与校验提示 */
export function mixHint(o2: number, he: number, method: FillMethod) {
  const n2 = Math.round((100 - o2 - he) * 10) / 10;
  const warnings: string[] = [];
  if (o2 < 0 || he < 0 || n2 < 0) warnings.push("各组分占比之和不能超过 100%");
  if (method === "空气") {
    if (Math.abs(o2 - 21) > 0.5 || he !== 0)
      warnings.push("空气充填应为 O₂ 21% / He 0%");
  }
  if (method === "高氧" && he !== 0) warnings.push("高氧（Nitrox）氦含量应为 0%");
  if (method === "高氧" && (o2 < 22 || o2 > 40))
    warnings.push("高氧充填 O₂ 常见范围 22%–40%");
  if (method === "Trimix" && (o2 < 8 || o2 > 25))
    warnings.push("Trimix O₂ 常见范围 8%–25%");
  if (method === "Trimix" && (he < 10 || he > 60))
    warnings.push("Trimix He 常见范围 10%–60%");
  return { n2, warnings };
}

/** 工单当前充填进度 0–1 */
export function currentProgress(order: Order, now: number): number {
  const durMs = order.durationMin * MIN_MS;
  if (order.status === "completed") return 1;
  if (order.status === "paused") return order.progressBase;
  if (order.status === "filling" && order.progressSince !== null) {
    return Math.min(
      1,
      order.progressBase + (now - order.progressSince) / durMs
    );
  }
  return 0;
}

export function equipmentDerivedStatus(
  equipmentId: string,
  state: AppState
): "idle" | "filling" | "maintenance" {
  if (state.maintenance.some((m) => m.equipmentId === equipmentId && m.end === null))
    return "maintenance";
  if (
    state.orders.some(
      (o) =>
        o.equipmentId === equipmentId &&
        (o.status === "filling" || o.status === "paused")
    )
  )
    return "filling";
  return "idle";
}

function orderEvent(kind: OrderEvent["kind"], message: string, t: number): OrderEvent {
  return { id: uid("ev"), t, kind, message };
}

function globalEvent(
  category: GlobalEvent["category"],
  message: string,
  t: number,
  refs: { orderId?: string; equipmentId?: string } = {}
): GlobalEvent {
  return { id: uid("log"), t, category, message, ...refs };
}

// ---------------------------------------------------------------------------
// 种子数据
// ---------------------------------------------------------------------------

function seedState(): AppState {
  const now = roundUpStep(Date.now());
  const equipment: Equipment[] = [
    { id: "CP-01", name: "1号主压缩机", kind: "compressor", model: "Bauer Mariner 250" },
    { id: "CP-02", name: "2号备用压缩机", kind: "compressor", model: "Bauer Oceanus 200" },
    { id: "FP-01", name: "1号充填泵", kind: "fillpump", model: "Haskel AG-30" },
    { id: "FP-02", name: "2号充填泵", kind: "fillpump", model: "Haskel AG-62" },
  ];

  const confirm = (
    contactName: string,
    phone: string,
    fillMethod: FillMethod,
    targetPressure: number,
    o2: number,
    he: number,
    operator: string,
    note = ""
  ): ConfirmInfo => ({
    contactName,
    phone,
    fillMethod,
    targetPressure,
    o2,
    he,
    operator,
    note,
    frozenAt: now,
  });

  const base = {
    volume: "12L 铝瓶",
    actualStart: null as number | null,
    completedAt: null as number | null,
    signedBy: null as string | null,
    signedAt: null as number | null,
    cancelledAt: null as number | null,
    progressBase: 0,
    progressSince: null as number | null,
    pausedAt: null as number | null,
    resumedAt: null as number | null,
    totalPauseMs: 0,
    pauseMinutes: 0,
    maintenanceId: null as string | null,
  };

  const orders: Order[] = [
    {
      ...base,
      id: uid("o"),
      code: "WO-1001",
      tankNo: "TANK-204",
      volume: "12L 铝瓶",
      inspectionExpiry: now + 45 * DAY_MS,
      residualPressure: 55,
      targetPressure: 200,
      o2: 21,
      he: 0,
      fillMethod: "空气",
      operator: "陈潜",
      contactName: "王跃",
      phone: "138****0204",
      equipmentId: "CP-01",
      start: now + 30 * MIN_MS,
      end: now + 90 * MIN_MS,
      durationMin: 60,
      status: "scheduled",
      rescheduleCount: 0,
      rescheduleLocked: false,
      confirmedInfo: confirm("王跃", "138****0204", "空气", 200, 21, 0, "陈潜"),
      events: [
        orderEvent("created", "工单创建，客户确认充填信息", now - 120 * MIN_MS),
      ],
    },
    {
      ...base,
      id: uid("o"),
      code: "WO-1002",
      tankNo: "TANK-219",
      volume: "11L 钢瓶",
      inspectionExpiry: now + 12 * DAY_MS,
      residualPressure: 40,
      targetPressure: 210,
      o2: 32,
      he: 0,
      fillMethod: "高氧",
      operator: "陈潜",
      contactName: "李海",
      phone: "139****0219",
      equipmentId: "CP-01",
      start: now + 95 * MIN_MS,
      end: now + 140 * MIN_MS,
      durationMin: 45,
      status: "scheduled",
      rescheduleCount: 0,
      rescheduleLocked: false,
      confirmedInfo: confirm("李海", "139****0219", "高氧", 210, 32, 0, "陈潜", "EAN32"),
      events: [
        orderEvent("created", "工单创建，客户确认 EAN32 高氧", now - 90 * MIN_MS),
      ],
    },
    {
      ...base,
      id: uid("o"),
      code: "WO-1003",
      tankNo: "TANK-231",
      volume: "双瓶组 2×12L",
      inspectionExpiry: now + 200 * DAY_MS,
      residualPressure: 30,
      targetPressure: 232,
      o2: 21,
      he: 0,
      fillMethod: "空气",
      operator: "周屿",
      contactName: "赵深",
      phone: "137****0231",
      equipmentId: "CP-01",
      start: now - 20 * MIN_MS,
      end: now + 25 * MIN_MS,
      durationMin: 45,
      status: "filling",
      actualStart: now - 20 * MIN_MS,
      progressSince: now - 20 * MIN_MS,
      rescheduleCount: 0,
      rescheduleLocked: false,
      confirmedInfo: confirm("赵深", "137****0231", "空气", 232, 21, 0, "周屿", "双瓶组"),
      events: [
        orderEvent("created", "工单创建，客户确认充填信息", now - 60 * MIN_MS),
        orderEvent("started", "开始充填", now - 20 * MIN_MS),
      ],
    },
    {
      ...base,
      id: uid("o"),
      code: "WO-1004",
      tankNo: "TANK-188",
      volume: "15L 钢瓶",
      inspectionExpiry: now + 90 * DAY_MS,
      residualPressure: 60,
      targetPressure: 220,
      o2: 18,
      he: 35,
      fillMethod: "Trimix",
      operator: "周屿",
      contactName: "孙潜",
      phone: "136****0188",
      equipmentId: "FP-01",
      start: now + 40 * MIN_MS,
      end: now + 70 * MIN_MS,
      durationMin: 30,
      status: "scheduled",
      rescheduleCount: 0,
      rescheduleLocked: false,
      confirmedInfo: confirm("孙潜", "136****0188", "Trimix", 220, 18, 35, "周屿", "O₂18/He35"),
      events: [
        orderEvent("created", "工单创建，客户确认 Trimix 配比", now - 60 * MIN_MS),
      ],
    },
    {
      ...base,
      id: uid("o"),
      code: "WO-1005",
      tankNo: "TANK-176",
      volume: "12L 铝瓶",
      inspectionExpiry: now + 300 * DAY_MS,
      residualPressure: 50,
      targetPressure: 200,
      o2: 36,
      he: 0,
      fillMethod: "高氧",
      operator: "陈潜",
      contactName: "林汐",
      phone: "135****0176",
      equipmentId: "CP-02",
      start: now + 180 * MIN_MS,
      end: now + 210 * MIN_MS,
      durationMin: 30,
      status: "scheduled",
      rescheduleCount: 2,
      rescheduleLocked: true,
      confirmedInfo: {
        ...confirm("林汐", "135****0176", "高氧", 200, 36, 0, "陈潜", "首次确认 EAN36"),
        frozenAt: now - 400 * MIN_MS,
      },
      events: [
        orderEvent("created", "工单创建，客户首次确认 EAN36", now - 400 * MIN_MS),
        orderEvent("rescheduled", "第 1 次改约", now - 300 * MIN_MS),
        orderEvent("rescheduled", "第 2 次改约：确认信息已锁定为首次快照", now - 200 * MIN_MS),
      ],
    },
    {
      ...base,
      id: uid("o"),
      code: "WO-1006",
      tankNo: "TANK-160",
      volume: "11L 钢瓶",
      inspectionExpiry: now - 3 * DAY_MS,
      residualPressure: 45,
      targetPressure: 200,
      o2: 21,
      he: 0,
      fillMethod: "空气",
      operator: "周屿",
      contactName: "高远",
      phone: "134****0160",
      equipmentId: "FP-02",
      start: now + 150 * MIN_MS,
      end: now + 190 * MIN_MS,
      durationMin: 40,
      status: "scheduled",
      rescheduleCount: 0,
      rescheduleLocked: false,
      confirmedInfo: confirm("高远", "134****0160", "空气", 200, 21, 0, "周屿", "检验已过期，待处理"),
      events: [
        orderEvent("created", "工单创建；气瓶检验已过期，充填前必须完成复检", now - 30 * MIN_MS),
      ],
    },
    {
      ...base,
      id: uid("o"),
      code: "WO-0998",
      tankNo: "TANK-155",
      volume: "12L 铝瓶",
      inspectionExpiry: now + 120 * DAY_MS,
      residualPressure: 60,
      targetPressure: 200,
      o2: 32,
      he: 0,
      fillMethod: "高氧",
      operator: "陈潜",
      contactName: "何川",
      phone: "133****0155",
      equipmentId: "FP-01",
      start: now - 200 * MIN_MS,
      end: now - 160 * MIN_MS,
      durationMin: 40,
      status: "completed",
      actualStart: now - 200 * MIN_MS,
      progressSince: now - 200 * MIN_MS,
      completedAt: now - 160 * MIN_MS,
      rescheduleCount: 0,
      rescheduleLocked: false,
      confirmedInfo: confirm("何川", "133****0155", "高氧", 200, 32, 0, "陈潜"),
      events: [
        orderEvent("created", "工单创建", now - 240 * MIN_MS),
        orderEvent("started", "开始充填", now - 200 * MIN_MS),
        orderEvent("completed", "充填完成，等待客户签收", now - 160 * MIN_MS),
      ],
    },
  ];

  return {
    now,
    equipment,
    orders,
    maintenance: [],
    log: [
      globalEvent("system", "演示数据已加载：可对 1号主压缩机 启动维护锁查看自动改约与暂停恢复", now),
    ],
  };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type Action =
  | { type: "TICK"; now: number }
  | { type: "RESET" }
  | {
      type: "CREATE_ORDER";
      order: Omit<
        Order,
        | "id"
        | "code"
        | "status"
        | "actualStart"
        | "completedAt"
        | "signedBy"
        | "signedAt"
        | "cancelledAt"
        | "progressBase"
        | "progressSince"
        | "pausedAt"
        | "resumedAt"
        | "totalPauseMs"
        | "pauseMinutes"
        | "maintenanceId"
        | "rescheduleCount"
        | "rescheduleLocked"
        | "confirmedInfo"
        | "events"
      >;
    }
  | { type: "START_FILL"; orderId: string }
  | { type: "SIGN_ORDER"; orderId: string; signer: string }
  | { type: "CANCEL_ORDER"; orderId: string }
  | { type: "MANUAL_RESCHEDULE"; orderId: string }
  | {
      type: "ENTER_MAINTENANCE";
      equipmentId: string;
      reason: string;
      durationMin: number;
    }
  | { type: "END_MAINTENANCE"; maintenanceId: string };

export interface ActionResult {
  ok: boolean;
  error?: string;
}

/**
 * 把工单改约到最近可用时段。改约后不能与同一设备任何时段重叠。
 * 改约计数达到 2 次后锁定：沿用客户首次确认信息，不允许被后续改约改写。
 */
function applyReschedule(
  draft: AppState,
  order: Order,
  anchor: number,
  trigger: "maintenance" | "manual",
  maintenanceId?: string
): void {
  const earliest = roundUpStep(Math.max(draft.now, anchor));
  const slot = findNearestSlot(
    draft,
    order.equipmentId,
    order.durationMin,
    earliest,
    order.id
  );
  const oldStart = order.start;
  order.start = slot.start;
  order.end = slot.end;
  order.rescheduleCount += 1;

  let message: string;
  if (order.rescheduleCount >= 2) {
    order.rescheduleLocked = true;
    const c = order.confirmedInfo;
    // 沿用首次确认信息：任何后续改约都以首次快照为准
    order.contactName = c.contactName;
    order.phone = c.phone;
    order.fillMethod = c.fillMethod;
    order.targetPressure = c.targetPressure;
    order.o2 = c.o2;
    order.he = c.he;
    order.operator = c.operator;
    message =
      trigger === "maintenance"
        ? `设备维护自动改约（第 ${order.rescheduleCount} 次）：${fmtTime(
            oldStart
          )} → ${fmtTime(slot.start)}；已达两次改约，沿用客户首次确认信息（${
            c.contactName
          } / ${c.fillMethod}${c.he > 0 ? ` O₂${c.o2} He${c.he}` : ` EAN${c.o2}`} / ${
            c.targetPressure
          }bar / 操作员${c.operator}）`
        : `第 ${order.rescheduleCount} 次改约：${fmtTime(
            oldStart
          )} → ${fmtTime(slot.start)}；沿用客户首次确认信息`;
  } else {
    message =
      trigger === "maintenance"
        ? `设备维护自动改约（第 ${order.rescheduleCount} 次）：${fmtTime(
            oldStart
          )} → ${fmtTime(slot.start)}`
        : `第 ${order.rescheduleCount} 次改约：${fmtTime(oldStart)} → ${fmtTime(
            slot.start
          )}`;
  }

  order.events.push(orderEvent("rescheduled", message, draft.now));
  draft.log.push(
    globalEvent("order", `工单 ${order.code} ${message}`, draft.now, {
      orderId: order.id,
      equipmentId: order.equipmentId,
    })
  );
  void maintenanceId;
}

/** 扫描设备上已排期工单，凡与既有忙时冲突的顺延到最近可用时段 */
function resolveSchedulingConflicts(
  draft: AppState,
  equipmentId: string
): Order[] {
  const moved: Order[] = [];
  const scheduled = draft.orders
    .filter(
      (o) => o.equipmentId === equipmentId && o.status === "scheduled"
    )
    .sort((a, b) => a.start - b.start);
  for (const o of scheduled) {
    if (
      slotHasConflict(draft, equipmentId, o.start, o.end, o.id)
    ) {
      applyReschedule(draft, o, Math.max(o.start, draft.now), "maintenance");
      moved.push(o);
    }
  }
  return moved;
}

function nextOrderCode(state: AppState): string {
  const max = state.orders.reduce((acc, o) => {
    const n = Number(o.code.replace("WO-", ""));
    return Number.isFinite(n) ? Math.max(acc, n) : acc;
  }, 1000);
  return `WO-${max + 1}`;
}

export function reducer(state: AppState | undefined, action: Action): AppState {
  if (state === undefined) return seedState();
  switch (action.type) {
    case "TICK": {
      if (action.now <= state.now) return state;
      const draft: AppState = { ...state, now: action.now };
      draft.orders = state.orders.map((o) => ({ ...o, events: [...o.events] }));
      for (const o of draft.orders) {
        const eqUnderMaint = draft.maintenance.some(
          (m) => m.equipmentId === o.equipmentId && m.end === null
        );
        // 到点自动开始充填（设备维护锁期间不得开始）
        if (o.status === "scheduled" && o.start <= draft.now && !eqUnderMaint) {
          o.status = "filling";
          o.actualStart = o.start;
          o.progressSince = o.start;
          o.events.push(
            orderEvent("started", `到达排班时段，开始充填`, draft.now)
          );
          draft.log.push(
            globalEvent("order", `工单 ${o.code} 开始充填`, draft.now, {
              orderId: o.id,
              equipmentId: o.equipmentId,
            })
          );
        }
        // 充填完成自动置为待签收
        if (o.status === "filling" && o.progressSince !== null) {
          const durMs = o.durationMin * MIN_MS;
          const finishAt =
            o.progressSince + (1 - o.progressBase) * durMs;
          if (finishAt <= draft.now) {
            o.status = "completed";
            o.completedAt = finishAt;
            o.progressBase = 1;
            o.progressSince = null;
            o.end = Math.max(o.end, finishAt);
            o.events.push(
              orderEvent("completed", "充填完成，等待客户签收", finishAt)
            );
            draft.log.push(
              globalEvent("order", `工单 ${o.code} 充填完成，待签收`, finishAt, {
                orderId: o.id,
                equipmentId: o.equipmentId,
              })
            );
          }
        }
      }
      return draft;
    }

    case "RESET":
      return seedState();

    case "CREATE_ORDER": {
      const data = action.order;
      if (data.inspectionExpiry < state.now) {
        return state; // UI 层负责提示：过期气瓶不允许新建充填
      }
      if (
        slotHasConflict(
          state,
          data.equipmentId,
          data.start,
          data.end,
          undefined
        )
      ) {
        return state; // UI 层负责提示：时段冲突，请使用推荐时段
      }
      const confirmed: ConfirmInfo = {
        contactName: data.contactName,
        phone: data.phone,
        fillMethod: data.fillMethod,
        targetPressure: data.targetPressure,
        o2: data.o2,
        he: data.he,
        operator: data.operator,
        note: "",
        frozenAt: state.now,
      };
      const order: Order = {
        ...data,
        id: uid("o"),
        code: nextOrderCode(state),
        status: "scheduled",
        actualStart: null,
        completedAt: null,
        signedBy: null,
        signedAt: null,
        cancelledAt: null,
        progressBase: 0,
        progressSince: null,
        pausedAt: null,
        resumedAt: null,
        totalPauseMs: 0,
        pauseMinutes: 0,
        maintenanceId: null,
        rescheduleCount: 0,
        rescheduleLocked: false,
        confirmedInfo: confirmed,
        events: [
          {
            id: uid("ev"),
            t: state.now,
            kind: "created",
            message: "工单创建，客户首次确认充填信息",
          },
        ],
      };
      return {
        ...state,
        orders: [order, ...state.orders],
        log: [
          globalEvent(
            "order",
            `新工单 ${order.code}（${order.tankNo} / ${order.fillMethod}）已排入 ${
              order.equipmentId
            } ${fmtTime(order.start)}`,
            state.now,
            { orderId: order.id, equipmentId: order.equipmentId }
          ),
          ...state.log,
        ],
      };
    }

    case "START_FILL": {
      const draft: AppState = { ...state, orders: state.orders.map((o) => ({ ...o, events: [...o.events] })) };
      const o = draft.orders.find((x) => x.id === action.orderId);
      if (!o || o.status !== "scheduled") return state;
      const eqUnderMaint = draft.maintenance.some(
        (m) => m.equipmentId === o.equipmentId && m.end === null
      );
      if (eqUnderMaint) return state;
      o.status = "filling";
      o.actualStart = draft.now;
      o.progressSince = draft.now;
      o.events.push(orderEvent("started", "操作员手动开始充填", draft.now));
      draft.log = [
        globalEvent("order", `工单 ${o.code} 开始充填`, draft.now, {
          orderId: o.id,
          equipmentId: o.equipmentId,
        }),
        ...draft.log,
      ];
      return draft;
    }

    case "SIGN_ORDER": {
      const draft: AppState = { ...state, orders: state.orders.map((o) => ({ ...o, events: [...o.events] })) };
      const o = draft.orders.find((x) => x.id === action.orderId);
      if (!o || o.status !== "completed" || o.signedBy) return state;
      const signer = action.signer.trim() || o.contactName;
      o.signedBy = signer;
      o.signedAt = draft.now;
      o.events.push(
        orderEvent("signed", `客户签收完成，签收人：${signer}`, draft.now)
      );
      draft.log = [
        globalEvent("order", `工单 ${o.code} 已由 ${signer} 签收`, draft.now, {
          orderId: o.id,
        }),
        ...draft.log,
      ];
      return draft;
    }

    case "CANCEL_ORDER": {
      const draft: AppState = { ...state, orders: state.orders.map((o) => ({ ...o, events: [...o.events] })) };
      const o = draft.orders.find((x) => x.id === action.orderId);
      if (!o || o.status !== "scheduled") return state;
      o.status = "cancelled";
      o.cancelledAt = draft.now;
      o.events.push(orderEvent("cancelled", "工单取消", draft.now));
      draft.log = [
        globalEvent("order", `工单 ${o.code} 已取消`, draft.now, { orderId: o.id }),
        ...draft.log,
      ];
      return draft;
    }

    case "MANUAL_RESCHEDULE": {
      const o0 = state.orders.find((x) => x.id === action.orderId);
      if (!o0 || o0.status !== "scheduled") return state;
      const draft: AppState = {
        ...state,
        orders: state.orders.map((o) => ({ ...o, events: [...o.events] })),
        log: [...state.log],
        maintenance: state.maintenance.map((m) => ({ ...m })),
      };
      const o = draft.orders.find((x) => x.id === action.orderId)!;
      applyReschedule(draft, o, o.end, "manual");
      return draft;
    }

    case "ENTER_MAINTENANCE": {
      const eq = state.equipment.find((e) => e.id === action.equipmentId);
      if (!eq) return state;
      if (
        state.maintenance.some(
          (m) => m.equipmentId === eq.id && m.end === null
        )
      )
        return state;
      const durationMin = Math.max(5, Math.round(action.durationMin));
      const draft: AppState = {
        ...state,
        orders: state.orders.map((o) => ({ ...o, events: [...o.events] })),
        maintenance: state.maintenance.map((m) => ({ ...m })),
        log: [...state.log],
      };
      const m = {
        id: uid("m"),
        equipmentId: eq.id,
        reason: action.reason.trim() || "例行维护",
        start: draft.now,
        expectedEnd: draft.now + durationMin * MIN_MS,
        end: null,
        pausedOrderIds: [] as string[],
        rescheduledOrderIds: [] as string[],
        resumedOrderIds: [] as string[],
      };

      // 1) 已开始充填的工单：保留现场、记录暂停时刻与暂停前进度
      for (const o of draft.orders) {
        if (o.equipmentId !== eq.id || o.status !== "filling") continue;
        const progress = currentProgress(o, draft.now);
        o.status = "paused";
        o.progressBase = progress;
        o.progressSince = null;
        o.pausedAt = draft.now;
        o.maintenanceId = m.id;
        o.events.push(
          orderEvent(
            "paused",
            `设备进入维护（${m.reason}），现场保留；暂停前进度 ${Math.round(
              progress * 100
            )}%（残压/目标压力/配比保持不动），维护结束后按该进度恢复`,
            draft.now
          )
        );
        draft.log.push(
          globalEvent(
            "order",
            `工单 ${o.code} 因维护暂停：暂停前进度 ${Math.round(
              progress * 100
            )}%，现场保留`,
            draft.now,
            { orderId: o.id, equipmentId: eq.id }
          )
        );
        m.pausedOrderIds.push(o.id);
      }

      draft.maintenance = [m, ...draft.maintenance];

      // 2) 未开始且与维护窗口重叠的工单：自动改约到最近可用时段
      const toMove = draft.orders
        .filter(
          (o) =>
            o.equipmentId === eq.id &&
            o.status === "scheduled" &&
            o.start < m.expectedEnd &&
            m.start < o.end
        )
        .sort((a, b) => a.start - b.start);
      for (const o of toMove) {
        applyReschedule(draft, o, Math.max(o.start, m.expectedEnd), "maintenance", m.id);
        m.rescheduledOrderIds.push(o.id);
      }

      // 3) 级联消解：被改约工单可能落到后续工单的时段上，顺延到真正无冲突的最近时段
      const cascaded = resolveSchedulingConflicts(draft, eq.id);
      for (const o of cascaded) {
        if (!m.rescheduledOrderIds.includes(o.id)) m.rescheduledOrderIds.push(o.id);
      }

      draft.log = [
        globalEvent(
          "maintenance",
          `${eq.name}（${eq.id}）进入维护锁：${m.reason}，预计 ${fmtDuration(
            durationMin * MIN_MS
          )}；暂停工单 ${m.pausedOrderIds.length} 个，自动改约工单 ${
            m.rescheduledOrderIds.length
          } 个`,
          draft.now,
          { equipmentId: eq.id }
        ),
        ...draft.log,
      ];
      return draft;
    }

    case "END_MAINTENANCE": {
      const m0 = state.maintenance.find((x) => x.id === action.maintenanceId && x.end === null);
      if (!m0) return state;
      const eq = state.equipment.find((e) => e.id === m0.equipmentId);
      const draft: AppState = {
        ...state,
        orders: state.orders.map((o) => ({ ...o, events: [...o.events] })),
        maintenance: state.maintenance.map((m) => ({
          ...m,
          pausedOrderIds: [...m.pausedOrderIds],
          rescheduledOrderIds: [...m.rescheduledOrderIds],
          resumedOrderIds: [...m.resumedOrderIds],
        })),
        log: [...state.log],
      };
      const m = draft.maintenance.find((x) => x.id === m0.id)!;
      m.end = draft.now;
      const actualPauseMs = Math.max(0, m.end - m.start);

      // 1) 被暂停的工单按暂停前进度恢复，记录暂停时长并顺延预计完成时间
      for (const o of draft.orders) {
        if (o.status !== "paused" || o.maintenanceId !== m.id) continue;
        const pauseMs = m.end - (o.pausedAt ?? m.start);
        o.totalPauseMs += pauseMs;
        o.pauseMinutes = Math.round(pauseMs / MIN_MS);
        o.status = "filling";
        o.progressSince = m.end; // progressBase 保留为暂停前进度
        o.resumedAt = m.end;
        o.pausedAt = null;
        o.end = o.end + pauseMs;
        o.events.push(
          orderEvent(
            "resumed",
            `维护结束，按暂停前进度 ${Math.round(
              o.progressBase * 100
            )}% 恢复充填；本次暂停 ${fmtDuration(
              pauseMs
            )}，预计完成时间顺延至 ${fmtTime(o.end)}`,
            m.end
          )
        );
        draft.log.push(
          globalEvent(
            "order",
            `工单 ${o.code} 恢复充填：沿用暂停前进度 ${Math.round(
              o.progressBase * 100
            )}%，暂停时长 ${fmtDuration(pauseMs)}`,
            m.end,
            { orderId: o.id, equipmentId: o.equipmentId }
          )
        );
        m.resumedOrderIds.push(o.id);
      }

      // 2) 维护超时：原本排在预计解锁点、实际仍落在维护时段内的未开工单，再次自动改约
      for (const o of draft.orders) {
        if (
          o.equipmentId === m.equipmentId &&
          o.status === "scheduled" &&
          o.start < m.end
        ) {
          applyReschedule(draft, o, Math.max(o.start, m.end), "maintenance", m.id);
          if (!m.rescheduledOrderIds.includes(o.id)) m.rescheduledOrderIds.push(o.id);
        }
      }

      // 3) 恢复后的工单发生顺延：刷新排班，冲突工单自动改约
      const moved = resolveSchedulingConflicts(draft, m.equipmentId);
      for (const o of moved) {
        if (!m.rescheduledOrderIds.includes(o.id)) m.rescheduledOrderIds.push(o.id);
      }

      draft.log = [
        globalEvent(
          "maintenance",
          `${eq?.name ?? m.equipmentId} 维护锁解除（实际 ${fmtDuration(
            actualPauseMs
          )}）：恢复工单 ${m.resumedOrderIds.length} 个，刷新排班并顺延冲突工单 ${
            moved.length
          } 个`,
          m.end,
          { equipmentId: m.equipmentId }
        ),
        ...draft.log,
      ];
      return draft;
    }
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

function loadInitial(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as AppState;
      if (parsed && Array.isArray(parsed.orders) && Array.isArray(parsed.equipment)) {
        return { ...parsed, now: roundUpStep(Date.now()) };
      }
    }
  } catch {
    // 忽略损坏的本地数据
  }
  return seedState();
}

interface StoreContextValue {
  state: AppState;
  dispatch: React.Dispatch<Action>;
}

const StoreContext = createContext<StoreContextValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, loadInitial);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // 存储失败不影响运行
    }
  }, [state]);

  // 演示时钟：每 15 秒推进 1 分钟，让充填进度与排班自动刷新
  useEffect(() => {
    const timer = setInterval(() => {
      dispatch({ type: "TICK", now: Date.now() });
    }, 15_000);
    return () => clearInterval(timer);
  }, []);

  const value = useMemo(() => ({ state, dispatch }), [state]);
  return (
    <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
  );
}

export function useStore(): StoreContextValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used within StoreProvider");
  return ctx;
}
