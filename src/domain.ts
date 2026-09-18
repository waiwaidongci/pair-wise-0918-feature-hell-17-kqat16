// 纯领域逻辑：维护锁、改约、排班冲突检测、暂停/恢复
// 所有函数不依赖 React，可直接在 Node 下用 node --test 验证。

import type {
  AuditEntry,
  Equipment,
  MaintenanceWindow,
  Order,
  OrderEvent,
  OrderStatus,
  PauseRecord,
  State,
  TankSpec,
} from "./types";

export const MIN = 60 * 1000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
/** 排班网格粒度，也是找“最近可用时段”时向前探测的步长 */
export const SLOT_STEP = 15 * MIN;
/** 工单之间的最小缓冲，避免首尾相接 */
export const GAP = 5 * MIN;

export interface TimeRange {
  start: number;
  end: number;
}

export function range(start: number, durationMin: number): TimeRange {
  return { start, end: start + durationMin * MIN };
}

export function overlap(a: TimeRange, b: TimeRange): boolean {
  return a.start < b.end && b.start < a.end;
}

let seq = 0;
export function uid(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq.toString(36)}`;
}

// ---------------------------------------------------------------------------
// 排班一致性
// ---------------------------------------------------------------------------

/**
 * 同一设备上参与时段占用的工单：
 * 已取消、已签收的历史工单不再占用未来时段；
 * 维护暂停中的工单“现场保留”，其恢复时段在维护结束时另行计算，
 * 因此检测排班（未开始工单）冲突时也不参与。
 */
function occupiesSlot(o: Order, now: number): boolean {
  if (o.status === "cancelled" || o.status === "signed") return false;
  if (o.status === "paused" || o.status === "inProgress" || o.status === "completed")
    return false;
  // confirmed：只关心尚未开始的；已到开始时间但尚未点击开始的仍按计划占位
  return o.scheduledStart + o.scheduledDurationMin * MIN > now - HOUR;
}

export function equipmentOrders(orders: Order[], equipmentId: string): Order[] {
  return orders.filter((o) => o.equipmentId === equipmentId);
}

/** 同一设备上未开始（confirmed）工单的时段是否两两不重叠 */
export function findScheduleConflict(orders: Order[], now: number): Order | null {
  const byEquip = new Map<string, Order[]>();
  for (const o of orders) {
    if (o.status !== "confirmed") continue;
    if (!occupiesSlot(o, now)) continue;
    const list = byEquip.get(o.equipmentId) ?? [];
    list.push(o);
    byEquip.set(o.equipmentId, list);
  }
  for (const list of byEquip.values()) {
    const sorted = [...list].sort((a, b) => a.scheduledStart - b.scheduledStart);
    for (let i = 1; i < sorted.length; i++) {
      const prev = range(sorted[i - 1].scheduledStart, sorted[i - 1].scheduledDurationMin);
      const cur = range(sorted[i].scheduledStart, sorted[i].scheduledDurationMin);
      if (overlap(prev, cur)) return sorted[i];
    }
  }
  return null;
}

export function isMaintenanceAt(eq: Equipment, t: number): boolean {
  const m = eq.maintenance;
  if (!m) return false;
  // 已登记 actualEnd 表示维护已结束
  return t >= m.start && (m.actualEnd === null || t < m.actualEnd);
}

/**
 * 候选时段必须避开：
 * 1. 同设备维护窗口（若维护超时，按实际结束时间动态顺延，见 nextAvailableStart）；
 * 2. 同设备其它未开始工单时段（含缓冲）；
 * 3. 暂停中保留现场的工单：它将在维护结束时立刻恢复，占用
 *    [维护实际结束, 维护实际结束 + 剩余工作量]。
 */
function blockedRanges(
  state: State,
  equipmentId: string,
  now: number,
  maintenanceActualEndHint?: number,
): TimeRange[] {
  const blocked: TimeRange[] = [];
  const eq = state.equipments.find((e) => e.id === equipmentId);
  if (eq?.maintenance) {
    const m = eq.maintenance;
    // 维护仍在进行（actualEnd 未回填）时，阻挡下界至少延伸到当前时刻，
    // 防止超时维护期间把工单排进正在进行的维护窗口。
    const liveEnd = m.actualEnd === null ? Math.max(m.plannedEnd, now) : m.actualEnd;
    blocked.push({
      start: m.start,
      end: Math.max(liveEnd, maintenanceActualEndHint ?? m.plannedEnd, m.plannedEnd),
    });
  }
  for (const o of state.orders) {
    if (o.equipmentId !== equipmentId) continue;
    if (o.status === "confirmed") {
      blocked.push(range(o.scheduledStart, o.scheduledDurationMin));
    } else if (o.status === "paused" && o.activePause) {
      // 现场保留：恢复点固定在维护结束，时长按暂停前进度剩余量计算
      const mEnd = Math.max(
        now,
        maintenanceActualEndHint ?? 0,
        o.activePause.maintenanceEnd ?? 0,
        eq?.maintenance?.plannedEnd ?? o.activePause.pausedAt,
      );
      const remainMin = remainingDurationMin(o, mEnd);
      blocked.push({ start: mEnd - GAP, end: mEnd + remainMin * MIN + GAP });
    }
  }
  return blocked;
}

/**
 * 找从 fromTime（对齐到 SLOT_STEP 网格）起、同一设备上最近的可用时段。
 * 不与维护窗口或同设备任何其它工单重叠。
 */
export function nextAvailableStart(
  state: State,
  equipmentId: string,
  durationMin: number,
  fromTime: number,
  now: number,
  maintenanceActualEndHint?: number,
): number {
  const candidate = (t: number): TimeRange => range(t, durationMin);
  // 首次探测保留调用方给的原始起点（避免把本不冲突的工单错误对齐移位），
  // 只有遇到阻挡后才跳到网格边界。
  let t = fromTime;
  for (let guard = 0; guard < 2000; guard++) {
    const r = candidate(t);
    const hit = blockedRanges(state, equipmentId, now, maintenanceActualEndHint).find((b) =>
      overlap(r, b),
    );
    if (!hit) return t;
    // 跳到阻挡区间结束之后（留缓冲），再对齐网格
    t = Math.ceil((hit.end + GAP) / SLOT_STEP) * SLOT_STEP;
  }
  return t;
}

// ---------------------------------------------------------------------------
// 暂停进度
// ---------------------------------------------------------------------------

/** 按线性进度估算某时刻应达到的压力（仅用于默认建议，实际以现场记录为准） */
export function expectedPressureAt(o: Order, t: number): number {
  if (!o.startedAt) return o.tank.residualBar;
  const total = o.tank.targetBar - o.tank.residualBar;
  const pct = Math.min(1, Math.max(0, (t - o.startedAt) / (o.scheduledDurationMin * MIN)));
  return Math.round(o.tank.residualBar + total * pct);
}

/** 暂停时剩余充填分钟数：按当前压力占目标比例线性折算 */
export function remainingDurationMin(o: Order, at: number): number {
  const total = o.tank.targetBar - o.tank.residualBar;
  if (total <= 0) return 0;
  const done = Math.min(total, Math.max(0, o.currentPressureBar - o.tank.residualBar));
  const remainRatio = 1 - done / total;
  return Math.max(1, Math.round(o.scheduledDurationMin * remainRatio));
}

// ---------------------------------------------------------------------------
// 事件 / 审计
// ---------------------------------------------------------------------------

export function addEvent(
  events: OrderEvent[],
  type: OrderEvent["type"],
  t: number,
  detail: string,
  rescheduleDelta?: number,
): OrderEvent[] {
  return [
    ...events,
    { id: uid("ev"), t, type, detail, ...(rescheduleDelta === undefined ? {} : { rescheduleDelta }) },
  ];
}

export function audit(state: State, t: number, text: string, level: AuditEntry["level"] = "info"): AuditEntry[] {
  return [{ id: uid("au"), t, level, text }, ...state.audit].slice(0, 200);
}

// ---------------------------------------------------------------------------
// 维护锁
// ---------------------------------------------------------------------------

export interface StartMaintenanceInput {
  equipmentId: string;
  reason: string;
  start: number;
  plannedDurationMin: number;
}

export interface StartMaintenanceResult {
  state: State;
  rescheduled: Order[];
  paused: Order[];
}

/**
 * 设备进入维护：
 * - 未开始（confirmed）工单 → 自动改约到维护结束后的最近可用时段；
 *   因维护超时造成的后续顺延不计入客户改约次数。
 * - 已开始（inProgress）工单 → 保留现场、转 paused，登记暂停起点与当前进度。
 */
export function startMaintenance(state: State, input: StartMaintenanceInput): StartMaintenanceResult {
  const eq = state.equipments.find((e) => e.id === input.equipmentId);
  if (!eq) throw new Error("设备不存在");
  if (eq.maintenance && eq.maintenance.actualEnd === null) {
    throw new Error(`${eq.name} 已处于维护中`);
  }

  const win: MaintenanceWindow = {
    reason: input.reason.trim() || "例行维护",
    start: input.start,
    plannedEnd: input.start + input.plannedDurationMin * MIN,
    actualEnd: null,
  };

  let orders = state.orders.map((o) =>
    o.equipmentId === input.equipmentId ? { ...o } : o,
  );
  const rescheduled: Order[] = [];
  const paused: Order[] = [];

  // 先处理进行中的工单：现场保留
  orders = orders.map((o) => {
    if (o.equipmentId !== input.equipmentId) return o;
    if (o.status !== "inProgress") return o;
    const pause: PauseRecord = {
      equipmentId: input.equipmentId,
      reason: win.reason,
      maintenanceStart: input.start,
      pausedAt: input.start,
      resumedAt: null,
      maintenanceEnd: null,
      durationMs: null,
      pressureAtPauseBar: o.currentPressureBar,
    };
    const next: Order = {
      ...o,
      status: "paused" as OrderStatus,
      activePause: pause,
      progressLog: [
        ...o.progressLog,
        { t: input.start, pressureBar: o.currentPressureBar, note: `设备维护暂停：${win.reason}` },
      ],
      events: addEvent(
        o.events,
        "maintenancePaused",
        input.start,
        `${eq.name} 进入维护，现场保留，当前压力 ${o.currentPressureBar}bar`,
      ),
    };
    paused.push(next);
    return next;
  });

  // 先登记维护锁（blockedRanges 依赖设备维护窗口），再做改约计算
  const equipments: Equipment[] = state.equipments.map((e) =>
    e.id === input.equipmentId ? { ...e, maintenance: win } : e,
  );

  // 再处理未开始工单：按开始时间顺序依次改约，保证互不重叠
  let work: State = { ...state, equipments, orders };
  const confirmed = orders
    .filter((o) => o.equipmentId === input.equipmentId && o.status === "confirmed")
    .sort((a, b) => a.scheduledStart - b.scheduledStart);

  for (const original of confirmed) {
    // 维护开始前已经能完成的工单不动
    const originalRange = range(original.scheduledStart, original.scheduledDurationMin);
    if (originalRange.end <= win.start) continue;

    const idx = work.orders.findIndex((o) => o.id === original.id);
    const cur = work.orders[idx];
    // 计算时排除自身：与维护窗口/暂停保留段/其它工单均不冲突则保持原时段
    const withoutSelf: State = {
      ...work,
      orders: work.orders.filter((o) => o.id !== cur.id),
    };
    const newStart = nextAvailableStart(
      withoutSelf,
      input.equipmentId,
      cur.scheduledDurationMin,
      cur.scheduledStart,
      input.start,
      win.plannedEnd,
    );
    if (newStart === cur.scheduledStart) continue;
    const updated: Order = {
      ...cur,
      scheduledStart: newStart,
      rescheduleCount: cur.rescheduleCount + 1,
      lastRescheduleReason: `设备维护自动改约：${win.reason}`,
      events: addEvent(
        cur.events,
        "rescheduled",
        input.start,
        `${eq.name} 维护，自动改约至 ${fmt(newStart)}`,
        1,
      ),
    };
    work = { ...work, orders: work.orders.map((o, i) => (i === idx ? updated : o)) };
    rescheduled.push(updated);
  }

  let log = audit(
    { ...work, audit: state.audit },
    input.start,
    `${eq.name} 进入维护（至 ${fmt(win.plannedEnd)}）：${rescheduled.length} 单自动改约，${paused.length} 单暂停保留现场`,
    rescheduled.length || paused.length ? "warn" : "info",
  );
  for (const o of rescheduled) {
    log = [{ id: uid("au"), t: input.start, level: "warn", text: `工单 ${o.no} 自动改约至 ${fmt(o.scheduledStart)}（第 ${o.rescheduleCount} 次改约）` }, ...log];
  }
  for (const o of paused) {
    log = [{ id: uid("au"), t: input.start, level: "warn", text: `工单 ${o.no} 暂停，现场保留，压力 ${o.currentPressureBar}bar` }, ...log];
  }

  return { state: { ...work, equipments, audit: log.slice(0, 200) }, rescheduled, paused };
}

export interface FinishMaintenanceResult {
  state: State;
  resumed: Order[];
  overrunMs: number;
}

/**
 * 维护结束：
 * - 回填实际结束时间（维护可能超时）；
 * - 暂停工单按暂停前进度恢复：剩余工作量从恢复时刻继续算；
 * - 若实际结束晚于计划，与恢复/既有排班里冲突的未开始工单顺延，
 *   超时顺延不增加客户改约次数（delta 0），仍沿用首次确认信息。
 */
export function finishMaintenance(state: State, equipmentId: string, end: number): FinishMaintenanceResult {
  const eq = state.equipments.find((e) => e.id === equipmentId);
  if (!eq?.maintenance || eq.maintenance.actualEnd !== null) {
    throw new Error("设备不在维护中");
  }
  const m = eq.maintenance;
  const actualEnd = Math.max(end, m.start);
  const overrunMs = Math.max(0, actualEnd - m.plannedEnd);

  // 1. 维护超时顺延：必须在维护锁仍登记、工单仍处于 paused 时计算，
  //    blockedRanges 会同时覆盖“延长后的维护窗口”和“暂停工单的恢复段”。
  let work: State = { ...state };
  if (overrunMs > 0) {
    const affected = work.orders
      .filter((o) => o.equipmentId === equipmentId && o.status === "confirmed")
      .sort((a, b) => a.scheduledStart - b.scheduledStart);

    for (const original of affected) {
      const idx = work.orders.findIndex((o) => o.id === original.id);
      const cur = work.orders[idx];
      const withoutSelf: State = {
        ...work,
        orders: work.orders.filter((o) => o.id !== cur.id),
      };
      const newStart = nextAvailableStart(
        withoutSelf,
        equipmentId,
        cur.scheduledDurationMin,
        cur.scheduledStart,
        actualEnd,
        actualEnd,
      );
      if (newStart === cur.scheduledStart) continue;
      const updated: Order = {
        ...cur,
        scheduledStart: newStart,
        lastRescheduleReason: `维护超时 ${fmtDuration(overrunMs)}，系统顺延（不计改约次数）`,
        events: addEvent(
          cur.events,
          "rescheduled",
          actualEnd,
          `维护超时，顺延至 ${fmt(newStart)}（不计改约次数）`,
          0,
        ),
      };
      work = { ...work, orders: work.orders.map((o, i) => (i === idx ? updated : o)) };
    }
  }

  // 2. 暂停工单恢复：现场保留，按暂停前进度计算剩余时长
  const resumed: Order[] = [];
  const orders = work.orders.map((o) => {
    if (o.equipmentId !== equipmentId || o.status !== "paused" || !o.activePause) return o;
    const pauseDuration = actualEnd - o.activePause.pausedAt;
    const pause: PauseRecord = {
      ...o.activePause,
      resumedAt: actualEnd,
      maintenanceEnd: actualEnd,
      durationMs: pauseDuration,
    };
    const remainMin = remainingDurationMin({ ...o, activePause: pause }, actualEnd);
    const next: Order = {
      ...o,
      status: "inProgress" as OrderStatus,
      activePause: null,
      pauseHistory: [...o.pauseHistory, pause],
      progressLog: [
        ...o.progressLog,
        { t: actualEnd, pressureBar: o.currentPressureBar, note: `维护结束恢复，暂停 ${fmtDuration(pauseDuration)}，剩余约 ${remainMin} 分钟` },
      ],
      events: addEvent(
        o.events,
        "maintenanceResumed",
        actualEnd,
        `按暂停前进度恢复（${o.currentPressureBar}bar），暂停时长 ${fmtDuration(pauseDuration)}`,
      ),
    };
    resumed.push(next);
    return next;
  });
  work = { ...work, orders };

  // 3. 回填维护锁实际结束时间 → 设备恢复可用
  const equipments = work.equipments.map((e) =>
    e.id === equipmentId
      ? { ...e, maintenance: { ...m, actualEnd } }
      : e,
  );
  work = { ...work, equipments };

  let log = audit(work, actualEnd, `${eq.name} 维护结束${overrunMs > 0 ? `（超时 ${fmtDuration(overrunMs)}）` : ""}：${resumed.length} 单恢复作业`);
  for (const o of resumed) {
    const p = o.pauseHistory[o.pauseHistory.length - 1];
    log = [{ id: uid("au"), t: actualEnd, level: "info", text: `工单 ${o.no} 恢复，暂停 ${fmtDuration(p.durationMs ?? 0)}，继续压力 ${o.currentPressureBar}bar` }, ...log];
  }

  return { state: { ...work, equipments, audit: log.slice(0, 200) }, resumed, overrunMs };
}

// ---------------------------------------------------------------------------
// 工单操作
// ---------------------------------------------------------------------------

export function startFill(
  state: State,
  orderId: string,
  now: number,
  pressureBar?: number,
): State {
  const eqById = new Map(state.equipments.map((e) => [e.id, e]));
  let found: Order | undefined;
  const orders = state.orders.map((o) => {
    if (o.id !== orderId) return o;
    const eq = eqById.get(o.equipmentId);
    if (eq && isMaintenanceAt(eq, now)) throw new Error("设备维护中，不能开始充填");
    if (o.status !== "confirmed") throw new Error("工单未处于待充填状态");
    found = o;
    const p = pressureBar ?? o.tank.residualBar;
    return {
      ...o,
      status: "inProgress" as OrderStatus,
      startedAt: now,
      currentPressureBar: p,
      progressLog: [...o.progressLog, { t: now, pressureBar: p, note: "开始充填" }],
      events: addEvent(o.events, "fillStarted", now, `开始充填，起始压力 ${p}bar`),
    };
  });
  if (!found) throw new Error("工单不存在");
  const eq = eqById.get(found.equipmentId)!;
  return {
    ...state,
    orders,
    audit: audit(state, now, `工单 ${found.no} 在 ${eq.name} 开始充填`),
  };
}

export function logPressure(state: State, orderId: string, now: number, pressureBar: number, note: string): State {
  const orders = state.orders.map((o) => {
    if (o.id !== orderId) return o;
    if (o.status !== "inProgress") throw new Error("仅进行中的工单可记录压力");
    return {
      ...o,
      currentPressureBar: pressureBar,
      progressLog: [...o.progressLog, { t: now, pressureBar, note: note || "压力记录" }],
      events: addEvent(o.events, "pressureLogged", now, `压力 ${pressureBar}bar${note ? `（${note}）` : ""}`),
    };
  });
  return { ...state, orders };
}

export function completeFill(state: State, orderId: string, now: number): State {
  let target: Order | undefined;
  const orders = state.orders.map((o) => {
    if (o.id !== orderId) return o;
    if (o.status !== "inProgress") throw new Error("仅进行中的工单可完成");
    target = o;
    return {
      ...o,
      status: "completed" as OrderStatus,
      currentPressureBar: o.tank.targetBar,
      completedAt: now,
      progressLog: [...o.progressLog, { t: now, pressureBar: o.tank.targetBar, note: "充填完成" }],
      events: addEvent(o.events, "fillCompleted", now, `充填完成 ${o.tank.targetBar}bar，待签收`),
    };
  });
  return {
    ...state,
    orders,
    audit: audit(state, now, `工单 ${target!.no} 充填完成，待客户签收`),
  };
}

export function signOrder(state: State, orderId: string, now: number, signName: string): State {
  let no = "";
  const orders = state.orders.map((o) => {
    if (o.id !== orderId) return o;
    if (o.status !== "completed") throw new Error("仅充填完成的工单可签收");
    if (!o.customer) throw new Error("缺少客户确认信息");
    no = o.no;
    return {
      ...o,
      status: "signed" as OrderStatus,
      signedAt: now,
      events: addEvent(o.events, "signed", now, `客户签收：${signName || o.customer.customerName}`),
    };
  });
  return { ...state, orders, audit: audit(state, now, `工单 ${no} 已签收`) };
}

/**
 * 客户改约：
 * - 同一设备时段不能重叠（自动找最近可用时段，若客户指定时间被占则顺延）；
 * - 改约满两次后，联系方式必须沿用首次确认信息（不可改名/换联系方式）；
 * - 满两次后再次改约仍然允许，但强制沿用首次信息。
 */
export function rescheduleOrder(
  state: State,
  orderId: string,
  requestedStart: number,
  now: number,
  customer?: { name: string; contact: string },
): { state: State; forcedFirstConfirm: boolean } {
  const idx = state.orders.findIndex((o) => o.id === orderId);
  if (idx < 0) throw new Error("工单不存在");
  const o = state.orders[idx];
  if (o.status !== "confirmed") throw new Error("仅未开始工单可改约");
  if (!o.customer) throw new Error("工单尚未客户确认");

  const forcedFirstConfirm = o.customerRescheduleCount >= 2;
  let customerPatch: Partial<Order> = {};
  if (customer) {
    if (forcedFirstConfirm) {
      // 沿用首次确认信息：忽略提交内容，强制回写首次快照
      customerPatch = {
        customer: {
          ...o.customer!,
          customerName: o.customer.firstConfirmedName,
          contact: o.customer.firstConfirmedContact,
        },
      };
    } else {
      const c = {
        ...o.customer,
        customerName: customer.name || o.customer.customerName,
        contact: customer.contact || o.customer.contact,
      };
      customerPatch = { customer: c };
    }
  } else if (forcedFirstConfirm) {
    customerPatch = {
      customer: {
        ...o.customer!,
        customerName: o.customer.firstConfirmedName,
        contact: o.customer.firstConfirmedContact,
      },
    };
  }

  // 计算时临时排除自身
  const withoutSelf: State = { ...state, orders: state.orders.filter((x) => x.id !== orderId) };
  const newStart = nextAvailableStart(
    withoutSelf,
    o.equipmentId,
    o.scheduledDurationMin,
    Math.max(requestedStart, now),
    now,
  );

  const updated: Order = {
    ...o,
    ...customerPatch,
    scheduledStart: newStart,
    rescheduleCount: o.rescheduleCount + 1,
    customerRescheduleCount: o.customerRescheduleCount + 1,
    lastRescheduleReason: forcedFirstConfirm ? "客户改约（沿用首次确认信息）" : "客户改约",
    events: addEvent(
      o.events,
      "rescheduled",
      now,
      `客户改约至 ${fmt(newStart)}${forcedFirstConfirm ? "，沿用首次确认信息" : ""}${newStart !== requestedStart ? "（指定时段被占用，已取最近可用时段）" : ""}`,
      1,
    ),
  };
  const orders = state.orders.map((x) => (x.id === orderId ? updated : x));
  return {
    state: {
      ...state,
      orders,
      audit: audit(
        state,
        now,
        `工单 ${o.no} 客户改约至 ${fmt(newStart)}（第 ${updated.rescheduleCount} 次）${forcedFirstConfirm ? "，沿用首次确认信息" : ""}`,
      ),
    },
    forcedFirstConfirm,
  };
}

export function confirmCustomer(
  state: State,
  orderId: string,
  name: string,
  contact: string,
  now: number,
): State {
  const orders = state.orders.map((o) => {
    if (o.id !== orderId) return o;
    if (o.customer) return o;
    return {
      ...o,
      customer: {
        customerName: name,
        contact,
        confirmedAt: now,
        firstConfirmedName: name,
        firstConfirmedContact: contact,
      },
      events: addEvent(o.events, "customerConfirmed", now, `客户首次确认：${name} / ${contact}`),
    };
  });
  return { ...state, orders };
}

// ---------------------------------------------------------------------------
// 派生状态
// ---------------------------------------------------------------------------

export function equipmentStatus(eq: Equipment, orders: Order[], now: number) {
  if (isMaintenanceAt(eq, now)) {
    const m = eq.maintenance!;
    return {
      key: "maintenance" as const,
      label: "维护中",
      detail: `${m.reason} · 预计 ${fmtTime(m.plannedEnd)}`,
      overrun: m.plannedEnd < now,
    };
  }
  const mine = orders.filter((o) => o.equipmentId === eq.id);
  if (mine.some((o) => o.status === "inProgress")) {
    return { key: "running" as const, label: "充填中", detail: "作业进行中", overrun: false };
  }
  if (mine.some((o) => o.status === "paused")) {
    return { key: "paused" as const, label: "暂停保留", detail: "等待维护结束恢复", overrun: false };
  }
  return { key: "idle" as const, label: "空闲", detail: "可排班", overrun: false };
}

// ---------------------------------------------------------------------------
// 格式化 & 校验
// ---------------------------------------------------------------------------

export function fmt(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtTime(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function fmtDuration(ms: number): string {
  const mins = Math.round(ms / MIN);
  if (mins < 60) return `${mins} 分钟`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

export function inspectionState(tank: TankSpec, now: number): "ok" | "soon" | "expired" {
  const end = new Date(tank.inspectionExpiry + "T23:59:59").getTime();
  const days = Math.floor((end - now) / DAY);
  if (days < 0) return "expired";
  if (days <= 30) return "soon";
  return "ok";
}

/** 混合气比例提示 */
export function mixHint(mode: string, o2: number, he: number): { ok: boolean; text: string } {
  if (mode === "air") {
    return { ok: o2 === 21 && he === 0, text: `空气充填：O₂ 21% / He 0%（当前 ${o2}%/${he}%）` };
  }
  if (mode === "nitrox") {
    const ok = o2 >= 28 && o2 <= 40 && he === 0;
    return { ok, text: `高氧 EAN${o2}：建议 O₂ 28–40%、He 0%；氮${100 - o2 - he}%` };
  }
  const ok = o2 >= 16 && o2 <= 21 && he >= 10 && he <= 50 && o2 + he <= 100;
  return {
    ok,
    text: `Trimix ${o2}/${he}：O₂ ${o2}% / He ${he}% / 氮${100 - o2 - he}%`,
  };
}
