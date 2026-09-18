// 领域规则测试：node --test（先经 tsc 编译到 test-dist）
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DAY,
  HOUR,
  MIN,
  finishMaintenance,
  findScheduleConflict,
  fmtDuration,
  nextAvailableStart,
  overlap,
  range,
  rescheduleOrder,
  startFill,
  startMaintenance,
} from "./domain";
import type { Order, State } from "./types";

const T0 = new Date("2026-09-18T09:00:00").getTime();

function makeOrder(p: Partial<Order> & { id: string; no: string; equipmentId: string }): Order {
  return {
    fillMode: "air",
    operator: "测试员",
    tank: {
      tankNo: `T-${p.id}`,
      volumeL: 12,
      inspectionExpiry: "2027-01-01",
      residualBar: 50,
      targetBar: 200,
      oxygenPct: 21,
      heliumPct: 0,
    },
    scheduledStart: T0,
    scheduledDurationMin: 30,
    status: "confirmed",
    startedAt: null,
    completedAt: null,
    signedAt: null,
    currentPressureBar: 50,
    progressLog: [],
    customer: {
      customerName: "张三",
      contact: "13800000000",
      confirmedAt: T0 - DAY,
      firstConfirmedName: "张三",
      firstConfirmedContact: "13800000000",
    },
    rescheduleCount: 0,
    customerRescheduleCount: 0,
    lastRescheduleReason: null,
    pauseHistory: [],
    activePause: null,
    events: [],
    createdAt: T0 - DAY,
    ...p,
  };
}

function makeState(orders: Order[]): State {
  return {
    version: 1,
    equipments: [
      { id: "c1", name: "压缩机1", kind: "compressor", maintenance: null },
      { id: "p1", name: "充填泵1", kind: "fillPump", maintenance: null },
    ],
    orders,
    audit: [],
    seededAt: T0,
  };
}

test("基础：区间重叠判定", () => {
  assert.equal(overlap(range(T0, 30), range(T0 + 30 * MIN, 30)), false, "首尾相接不重叠（无缓冲时）");
  assert.equal(overlap(range(T0, 30), range(T0 + 25, 30)), true);
});

test("上锁：未开始工单改约到维护结束后的最近可用时段，且同设备不重叠", () => {
  const s0 = makeState([
    makeOrder({ id: "a", no: "A", equipmentId: "c1", scheduledStart: T0 + 5 * MIN, scheduledDurationMin: 30 }),
    makeOrder({ id: "b", no: "B", equipmentId: "c1", scheduledStart: T0 + 40 * MIN, scheduledDurationMin: 30 }),
    makeOrder({ id: "x", no: "X", equipmentId: "p1", scheduledStart: T0 + 5 * MIN, scheduledDurationMin: 30 }),
  ]);

  const { state: s1, rescheduled, paused } = startMaintenance(s0, {
    equipmentId: "c1",
    reason: "换油保养",
    start: T0,
    plannedDurationMin: 60,
  });

  assert.equal(rescheduled.length, 2, "两台未开始工单都被改约");
  assert.equal(paused.length, 0);
  assert.equal(findScheduleConflict(s1.orders, T0), null, "刷新后排班无同设备重叠");

  const plannedEnd = T0 + 60 * MIN;
  for (const o of rescheduled) {
    assert.ok(o.scheduledStart >= plannedEnd, `${o.no} 排在维护结束之后`);
    assert.equal(o.rescheduleCount, 1, `${o.no} 记一次改约`);
  }
  // 两单仍按先后排列、不重叠（含 5 分钟缓冲）
  const [a, b] = rescheduled.sort((x, y) => x.scheduledStart - y.scheduledStart);
  assert.ok(a.scheduledStart + a.scheduledDurationMin * MIN <= b.scheduledStart, "A 结束不晚于 B 开始（网格含缓冲）");

  // 其它设备工单不动
  const x = s1.orders.find((o) => o.id === "x")!;
  assert.equal(x.scheduledStart, T0 + 5 * MIN);

  // 设备状态
  assert.equal(s1.equipments[0].maintenance!.actualEnd, null);
  assert.equal(s1.equipments[0].maintenance!.reason, "换油保养");
});

test("上锁：进行中工单保留现场并记录暂停压力，解锁后按暂停前进度恢复", () => {
  const running = makeOrder({
    id: "r",
    no: "R",
    equipmentId: "c1",
    status: "inProgress",
    startedAt: T0 - 10 * MIN,
    scheduledDurationMin: 50,
    currentPressureBar: 110, // 50 -> 200，完成约 40%
  });
  const s0 = makeState([running]);

  const { state: locked, paused } = startMaintenance(s0, {
    equipmentId: "c1",
    reason: "异响检修",
    start: T0,
    plannedDurationMin: 60,
  });
  assert.equal(paused.length, 1);
  const p = locked.orders[0];
  assert.equal(p.status, "paused");
  assert.equal(p.activePause!.pressureAtPauseBar, 110, "暂停时压力快照保留");
  assert.equal(p.activePause!.pausedAt, T0);
  assert.equal(p.currentPressureBar, 110, "现场压力不变");

  const { state: unlocked, resumed } = finishMaintenance(locked, "c1", T0 + 60 * MIN);
  assert.equal(resumed.length, 1);
  const r2 = unlocked.orders[0];
  assert.equal(r2.status, "inProgress");
  assert.equal(r2.currentPressureBar, 110, "按暂停前压力进度恢复");
  assert.equal(r2.activePause, null);
  assert.equal(r2.pauseHistory.length, 1);
  assert.equal(r2.pauseHistory[0].durationMs, 60 * MIN, "暂停时长 60 分钟已结算");
  // 剩余工作量：50 分钟总量的约 60% => 30 分钟
  const remainRatio = 1 - (110 - 50) / (200 - 50);
  assert.equal(Math.round(50 * remainRatio), 30);
  assert.equal(unlocked.equipments[0].maintenance!.actualEnd, T0 + 60 * MIN);
});

test("维护超时：受影响工单顺延且不计改约次数；与恢复工单不重叠", () => {
  // A 单进行中（暂停后恢复会占用实际结束后的时段）；B 单排在计划结束之后但与超时窗口冲突
  const a = makeOrder({
    id: "a", no: "A", equipmentId: "c1",
    status: "inProgress", startedAt: T0 - 10 * MIN,
    scheduledDurationMin: 50, currentPressureBar: 110,
  });
  const b = makeOrder({
    id: "b", no: "B", equipmentId: "c1",
    scheduledStart: T0 + 65 * MIN, scheduledDurationMin: 30,
  });
  const s0 = makeState([a, b]);

  const locked = startMaintenance(s0, {
    equipmentId: "c1", reason: "超时检修", start: T0, plannedDurationMin: 60,
  }).state;

  // B 在 60 分钟计划维护下被排到计划结束后；实际维护 100 分钟才结束
  const bBefore = locked.orders.find((o) => o.id === "b")!;
  const countBefore = bBefore.rescheduleCount;

  const { state: unlocked, resumed, overrunMs } = finishMaintenance(locked, "c1", T0 + 100 * MIN);
  assert.equal(overrunMs, 40 * MIN);
  assert.equal(resumed.length, 1);

  const bAfter = unlocked.orders.find((o) => o.id === "b")!;
  assert.equal(bAfter.rescheduleCount, countBefore, "超时顺延不增加客户改约次数");
  assert.ok(bAfter.scheduledStart >= T0 + 100 * MIN, "B 排在实际结束之后");
  // A 恢复段：实际结束 + 剩余 30 分钟；B 不得与之重叠
  const aResume = { start: T0 + 100 * MIN, end: T0 + 100 * MIN + 30 * MIN };
  const bRange = range(bAfter.scheduledStart, bAfter.scheduledDurationMin);
  assert.equal(overlap(aResume, bRange), false, "恢复工单与顺延工单不重叠");
  assert.equal(findScheduleConflict(unlocked.orders, T0), null);

  // 超时顺延事件 delta=0
  const ev = bAfter.events.filter((e) => e.type === "rescheduled").at(-1)!;
  assert.equal(ev.rescheduleDelta, 0);
});

test("改约：同设备占用时取最近可用时段", () => {
  const s0 = makeState([
    makeOrder({ id: "a", no: "A", equipmentId: "c1", scheduledStart: T0 + 2 * HOUR, scheduledDurationMin: 30 }),
    makeOrder({ id: "b", no: "B", equipmentId: "c1", scheduledStart: T0 + 4 * HOUR, scheduledDurationMin: 30 }),
  ]);
  // B 想改到 A 的时段 -> 应被顺延到 A 之后
  const { state: s1 } = rescheduleOrder(s0, "b", T0 + 2 * HOUR + 5 * MIN, T0);
  const b = s1.orders.find((o) => o.id === "b")!;
  const a = s1.orders.find((o) => o.id === "a")!;
  assert.ok(b.scheduledStart >= a.scheduledStart + a.scheduledDurationMin * MIN);
  assert.equal(b.rescheduleCount, 1);
  assert.equal(findScheduleConflict(s1.orders, T0), null);
});

test("客户改约满两次后沿用首次确认信息；维护自动改约不占用客户次数", () => {
  const s0 = makeState([
    makeOrder({
      id: "a", no: "A", equipmentId: "c1",
      scheduledStart: T0 + HOUR, scheduledDurationMin: 30,
      rescheduleCount: 3, // 历史上含维护自动改约
      customerRescheduleCount: 2, // 客户自己已经改过两次
    }),
  ]);
  const { state: s1, forcedFirstConfirm } = rescheduleOrder(
    s0, "a", T0 + 3 * HOUR, T0,
    { name: "李四", contact: "13900000000" },
  );
  assert.equal(forcedFirstConfirm, true);
  const a = s1.orders[0];
  assert.equal(a.customer!.customerName, "张三", "姓名被回写为首次确认值");
  assert.equal(a.customer!.contact, "13800000000", "联系方式被回写为首次确认值");
  assert.equal(a.customerRescheduleCount, 3, "客户改约次数累加");
  assert.equal(a.rescheduleCount, 4, "总改约次数累加");
  const last = a.events.at(-1)!;
  assert.match(last.detail, /沿用首次确认信息/);
});

test("未满两次：客户改约允许更新联系方式，客户次数与总次数分别累计", () => {
  const s0 = makeState([
    makeOrder({
      id: "a", no: "A", equipmentId: "c1",
      scheduledStart: T0 + HOUR, scheduledDurationMin: 30,
      rescheduleCount: 1,
      customerRescheduleCount: 0,
    }),
  ]);
  const { state: s1, forcedFirstConfirm } = rescheduleOrder(
    s0, "a", T0 + 3 * HOUR, T0,
    { name: "张三改名", contact: "13700000000" },
  );
  assert.equal(forcedFirstConfirm, false);
  const a = s1.orders[0];
  assert.equal(a.customer!.customerName, "张三改名");
  assert.equal(a.customer!.firstConfirmedName, "张三", "首次快照永不改变");
  assert.equal(a.customerRescheduleCount, 1);
  assert.equal(a.rescheduleCount, 2);
});

test("最近可用时段：避开维护窗口与多张工单", () => {
  const locked = startMaintenance(
    makeState([
      makeOrder({ id: "b", no: "B", equipmentId: "c1", scheduledStart: T0 + 90 * MIN, scheduledDurationMin: 30 }),
    ]),
    { equipmentId: "c1", reason: "保养", start: T0, plannedDurationMin: 60 },
  ).state;
  // 维护 [T0,T0+60]，B 被改约到 T0+60 之后；新工单 30 分钟应排在 B 之后
  const t = nextAvailableStart(locked, "c1", 30, T0 + 10 * MIN, T0);
  const b = locked.orders.find((o) => o.id === "b")!;
  assert.ok(t >= b.scheduledStart + b.scheduledDurationMin * MIN, `t=${new Date(t).toISOString()} bEnd=${new Date(b.scheduledStart + b.scheduledDurationMin * MIN).toISOString()}`);
});

test("维护超时未解锁期间，客户改约不得排进进行中的维护窗口", () => {
  // 60 分钟计划维护；工单排在计划结束后 10 分钟
  const s0 = makeState([
    makeOrder({ id: "b", no: "B", equipmentId: "c1", scheduledStart: T0 + 75 * MIN, scheduledDurationMin: 30 }),
  ]);
  const locked = startMaintenance(s0, {
    equipmentId: "c1", reason: "保养", start: T0, plannedDurationMin: 60,
  }).state;
  // 时钟推进到 T0+90 分钟（维护已超时，仍未解锁），客户想改到 09:50
  const now90 = T0 + 90 * MIN;
  const { state: s1 } = rescheduleOrder(locked, "b", T0 + 50 * MIN, now90);
  const b = s1.orders[0];
  assert.ok(
    b.scheduledStart >= now90,
    `改约结果必须不早于当前时刻（实际 ${new Date(b.scheduledStart).toISOString()}）`,
  );
  assert.equal(findScheduleConflict(s1.orders, now90), null);
});

test("全链路一致：设备状态、工单历史、排班互不矛盾", () => {
  let s = makeState([
    makeOrder({ id: "a", no: "A", equipmentId: "c1", scheduledStart: T0, scheduledDurationMin: 30 }),
    makeOrder({ id: "b", no: "B", equipmentId: "c1", scheduledStart: T0 + 40 * MIN, scheduledDurationMin: 30 }),
    makeOrder({ id: "r", no: "R", equipmentId: "c1", status: "inProgress", startedAt: T0 - 5 * MIN, currentPressureBar: 90 }),
  ]);
  s = startMaintenance(s, { equipmentId: "c1", reason: "保养", start: T0, plannedDurationMin: 45 }).state;
  s = finishMaintenance(s, "c1", T0 + 75 * MIN).state; // 超时 30 分钟

  // 1. 排班无冲突
  assert.equal(findScheduleConflict(s.orders, T0), null);
  // 2. 工单事件历史完整
  const r = s.orders.find((o) => o.id === "r")!;
  assert.deepEqual(
    r.events.map((e) => e.type).filter((t) => t.startsWith("maintenance")),
    ["maintenancePaused", "maintenanceResumed"],
  );
  // 3. 维护锁已闭合
  const m = s.equipments[0].maintenance!;
  assert.ok(m.actualEnd !== null && m.actualEnd > m.plannedEnd);
  // 4. 暂停时长已写入历史
  assert.equal(r.pauseHistory[0].durationMs, 75 * MIN);
  // 5. 所有未开始工单都在实际维护结束之后
  for (const o of s.orders.filter((o) => o.status === "confirmed")) {
    assert.ok(o.scheduledStart >= m.actualEnd, `${o.no} 排在实际维护结束之后`);
  }
  // 6. 暂停恢复后压力不变
  assert.equal(r.currentPressureBar, 90);

  assert.ok(fmtDuration(75 * MIN).includes("1 小时 15 分"));
});

test("维护中设备不能开始新充填", () => {
  let s = makeState([makeOrder({ id: "a", no: "A", equipmentId: "c1", scheduledStart: T0 + 2 * HOUR })]);
  s = startMaintenance(s, { equipmentId: "c1", reason: "保养", start: T0, plannedDurationMin: 60 }).state;
  assert.throws(() => startFill(s, "a", T0 + 10 * MIN), /维护中/);
});
