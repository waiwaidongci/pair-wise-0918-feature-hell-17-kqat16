import type {
  AppState,
  MaintenanceWindow,
  Order,
  OrderStatus,
} from "./types";

/** 排班以 5 分钟为最小粒度 */
export const SLOT_STEP_MIN = 5;
export const SLOT_STEP_MS = SLOT_STEP_MIN * 60_000;

export function roundUpStep(ts: number): number {
  return Math.ceil(ts / SLOT_STEP_MS) * SLOT_STEP_MS;
}

/** 半开区间重叠判定：[aStart, aEnd) × [bStart, bEnd) */
export function overlaps(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function mergeIntervals(
  intervals: Array<[number, number]>
): Array<[number, number]> {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [sorted[0]];
  for (const [s, e] of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (s <= last[1]) {
      if (e > last[1]) last[1] = e;
    } else {
      merged.push([s, e]);
    }
  }
  return merged;
}

/**
 * 工单在时间轴上占用的区间。
 * - scheduled / filling：[start, end)
 * - paused（维护锁现场保留）：到维护预计解锁 + 剩余充填时长为止，
 *   既覆盖维护窗口（现场不可排新单），也覆盖恢复后所需的设备时间
 * - completed / cancelled：不再占用未来排班
 *
 * @param resumeFrom 维护预计解锁时间（暂停工单需要）
 */
export function orderBusyInterval(
  order: Order,
  resumeFrom?: number
): [number, number] | null {
  if (order.status === "paused") {
    const remainingMs =
      (1 - order.progressBase) * order.durationMin * 60_000;
    const finishAt =
      (resumeFrom ?? order.pausedAt ?? order.end) + remainingMs;
    return [order.start, Math.max(order.end, finishAt)];
  }
  if (order.status === "scheduled" || order.status === "filling") {
    return [order.start, order.end];
  }
  return null;
}

/** 进行中的维护锁占用区间；已结束维护不挡未来排程 */
function maintenanceInterval(m: MaintenanceWindow): [number, number] | null {
  return m.end === null ? [m.start, m.expectedEnd] : null;
}

export function busyIntervals(
  orders: Order[],
  maintenance: MaintenanceWindow[],
  equipmentId: string,
  opts: { includeOrderId?: string } = {}
): Array<[number, number]> {
  const intervals: Array<[number, number]> = [];
  for (const o of orders) {
    if (o.equipmentId !== equipmentId) continue;
    if (o.id === opts.includeOrderId) continue;
    let resumeFrom: number | undefined;
    if (o.status === "paused" && o.maintenanceId) {
      const m = maintenance.find((x) => x.id === o.maintenanceId);
      resumeFrom = m ? m.expectedEnd : undefined;
    }
    const iv = orderBusyInterval(o, resumeFrom);
    if (iv) intervals.push(iv);
  }
  for (const m of maintenance) {
    if (m.equipmentId !== equipmentId) continue;
    const iv = maintenanceInterval(m);
    if (iv) intervals.push(iv);
  }
  return mergeIntervals(intervals);
}

/**
 * 查找某设备上、从 earliestStart 起能容纳 durationMin 的最近可用时段。
 * 不与该设备任何其他工单或维护窗口重叠；找不到锚点前的空隙时，顺延到忙时之后。
 */
export function findNearestSlot(
  state: Pick<AppState, "orders" | "maintenance">,
  equipmentId: string,
  durationMin: number,
  earliestStart: number,
  excludeOrderId?: string
): { start: number; end: number } {
  const durationMs = durationMin * 60_000;
  const intervals = busyIntervals(
    state.orders,
    state.maintenance,
    equipmentId,
    { includeOrderId: excludeOrderId }
  );

  let candidate = roundUpStep(earliestStart);
  for (const [busyStart, busyEnd] of intervals) {
    if (candidate + durationMs <= busyStart) {
      // candidate 落在该忙区间之前的空隙
      return { start: candidate, end: candidate + durationMs };
    }
    if (overlaps(candidate, candidate + durationMs, busyStart, busyEnd)) {
      candidate = roundUpStep(busyEnd);
    }
  }
  return { start: candidate, end: candidate + durationMs };
}

/** 校验指定工单排到 [start,end) 是否与同设备其他时段冲突 */
export function slotHasConflict(
  state: Pick<AppState, "orders" | "maintenance">,
  equipmentId: string,
  start: number,
  end: number,
  excludeOrderId?: string
): boolean {
  for (const iv of busyIntervals(
    state.orders,
    state.maintenance,
    equipmentId,
    { includeOrderId: excludeOrderId }
  )) {
    if (overlaps(start, end, iv[0], iv[1])) return true;
  }
  return false;
}

export interface ConsistencyIssue {
  kind:
    | "slot-overlap"
    | "order-during-maintenance"
    | "paused-without-maintenance"
    | "filling-on-maintenance"
    | "status-mismatch"
    | "equipment-status";
  message: string;
  orderId?: string;
  equipmentId?: string;
}

const ACTIVE_STATUSES: OrderStatus[] = ["scheduled", "filling", "paused"];

/**
 * 三方一致性检查：设备状态 / 工单历史 / 刷新后的排班必须一致。
 * 返回所有违反不变量的问题；空数组表示一致。
 */
export function findConsistencyIssues(
  state: AppState
): ConsistencyIssue[] {
  const issues: ConsistencyIssue[] = [];
  const activeMaintenanceByEq = new Map<string, MaintenanceWindow>();
  for (const m of state.maintenance) {
    if (m.end === null) {
      if (activeMaintenanceByEq.has(m.equipmentId)) {
        issues.push({
          kind: "slot-overlap",
          equipmentId: m.equipmentId,
          message: "同一设备存在两个未结束的维护锁",
        });
      }
      activeMaintenanceByEq.set(m.equipmentId, m);
    }
  }

  // 1) 同一设备活跃工单之间不能时段重叠
  const byEquipment = new Map<string, Order[]>();
  for (const o of state.orders) {
    if (!ACTIVE_STATUSES.includes(o.status)) continue;
    if (
      o.status === "scheduled" &&
      o.start < state.now &&
      o.end <= state.now &&
      !state.maintenance.some(
        (m) => m.equipmentId === o.equipmentId && m.end === null
      )
    ) {
      issues.push({
        kind: "status-mismatch",
        orderId: o.id,
        message: `工单 ${o.code} 时段已过却仍为“已排期”`,
      });
    }
    const list = byEquipment.get(o.equipmentId) ?? [];
    list.push(o);
    byEquipment.set(o.equipmentId, list);
  }
  for (const [eqId, list] of byEquipment) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        const resumeA = state.maintenance.find(
          (m) => m.id === a.maintenanceId
        )?.expectedEnd;
        const resumeB = state.maintenance.find(
          (m) => m.id === b.maintenanceId
        )?.expectedEnd;
        const ia = orderBusyInterval(a, resumeA)!;
        const ib = orderBusyInterval(b, resumeB)!;
        if (overlaps(ia[0], ia[1], ib[0], ib[1])) {
          issues.push({
            kind: "slot-overlap",
            equipmentId: eqId,
            orderId: a.id,
            message: `工单 ${a.code} 与 ${b.code} 在同一设备时段重叠`,
          });
        }
      }
    }
  }

  // 2) 维护窗口与工单不能重叠（暂停现场的工单除外，它被维护显式接管）
  for (const m of state.maintenance) {
    const mEnd = m.end ?? m.expectedEnd;
    for (const o of state.orders) {
      if (o.equipmentId !== m.equipmentId) continue;
      if (o.status === "completed" || o.status === "cancelled") continue;
      let resumeFrom: number | undefined;
      if (o.maintenanceId) {
        resumeFrom =
          state.maintenance.find((x) => x.id === o.maintenanceId)
            ?.expectedEnd ?? undefined;
      }
      const iv = orderBusyInterval(o, resumeFrom);
      if (!iv) continue;
      const overlap = overlaps(iv[0], iv[1], m.start, mEnd);
      if (o.status === "paused") {
        if (o.maintenanceId !== m.id && overlap) {
          issues.push({
            kind: "paused-without-maintenance",
            orderId: o.id,
            message: `工单 ${o.code} 已暂停但未关联到对应维护锁`,
          });
        }
        if (m.end === null && !m.pausedOrderIds.includes(o.id)) {
          issues.push({
            kind: "status-mismatch",
            orderId: o.id,
            message: `工单 ${o.code} 处于维护暂停但维护记录未登记该工单`,
          });
        }
        continue;
      }
      // 已结束维护接管过的工单（暂停现场 / 恢复 / 自动改约）属于历史事实，不算冲突
      const managedByEndedMaint =
        m.end !== null &&
        (m.pausedOrderIds.includes(o.id) ||
          m.rescheduledOrderIds.includes(o.id) ||
          m.resumedOrderIds.includes(o.id));
      if (overlap && !managedByEndedMaint && (m.end === null || o.status !== "scheduled")) {
        issues.push({
          kind: o.status === "filling"
            ? "filling-on-maintenance"
            : "order-during-maintenance",
          orderId: o.id,
          equipmentId: m.equipmentId,
          message: `工单 ${o.code} 与设备维护窗口时段冲突`,
        });
      }
    }
  }

  // 3) 改约锁定后，确认信息必须仍是首次快照
  for (const o of state.orders) {
    if (o.rescheduleLocked) {
      const c = o.confirmedInfo;
      if (
        c.contactName !== o.contactName ||
        c.phone !== o.phone ||
        c.fillMethod !== o.fillMethod ||
        c.targetPressure !== o.targetPressure ||
        c.o2 !== o.o2 ||
        c.he !== o.he ||
        c.operator !== o.operator
      ) {
        issues.push({
          kind: "status-mismatch",
          orderId: o.id,
          message: `工单 ${o.code} 两次改约后确认信息与首次快照不一致`,
        });
      }
    }
  }

  // 4) 设备派生状态校验：维护中的设备不允许存在 filling 工单
  for (const [eqId] of activeMaintenanceByEq) {
    const filling = state.orders.find(
      (o) => o.equipmentId === eqId && o.status === "filling"
    );
    if (filling) {
      issues.push({
        kind: "equipment-status",
        equipmentId: eqId,
        orderId: filling.id,
        message: `设备处于维护锁，但工单 ${filling.code} 仍在充填`,
      });
    }
  }

  return issues;
}
