// 端到端场景演练：一个真实班次的"上锁 → 客户改约 → 超时 → 解锁恢复"
// 用法：npx tsc -p tsconfig.test.json && node scripts/e2e.js
const assert = require("node:assert");
const {
  startMaintenance,
  finishMaintenance,
  rescheduleOrder,
  findScheduleConflict,
  range,
  overlap,
  MIN,
  HOUR,
  DAY,
} = require("../test-dist/domain.js");

const T0 = new Date("2026-09-18T09:00:00").getTime();
const first = { name: "陈晨", phone: "130-1111-2222" };
let oid = 0;
function order(equipmentId, startMin, durMin, status = "confirmed", extra = {}) {
  oid += 1;
  return {
    id: `o${oid}`,
    no: `F-${2000 + oid}`,
    equipmentId,
    fillMode: "air",
    operator: "老周",
    tank: { tankNo: `T-${oid}`, volumeL: 12, inspectionExpiry: "2027-05-01", residualBar: 40, targetBar: 200, oxygenPct: 21, heliumPct: 0 },
    scheduledStart: T0 + startMin * MIN,
    scheduledDurationMin: durMin,
    status,
    startedAt: status === "inProgress" ? T0 + startMin * MIN : null,
    completedAt: null,
    signedAt: null,
    currentPressureBar: status === "inProgress" ? extra.p ?? 120 : 40,
    progressLog: [],
    customer: {
      customerName: first.name,
      contact: first.phone,
      confirmedAt: T0 - DAY,
      firstConfirmedName: first.name,
      firstConfirmedContact: first.phone,
    },
    rescheduleCount: 0,
    customerRescheduleCount: 0,
    lastRescheduleReason: null,
    pauseHistory: [],
    activePause: null,
    events: [],
    createdAt: T0 - HOUR,
  };
}

let state = {
  version: 1,
  seededAt: T0,
  audit: [],
  equipments: [
    { id: "c1", name: "1号压缩机", kind: "compressor", maintenance: null },
    { id: "p1", name: "充填泵A", kind: "fillPump", maintenance: null },
  ],
  orders: [
    order("c1", 0, 30),                       // 09:00 待充填
    order("c1", 40, 30),                      // 09:40 待充填
    order("c1", 150, 30),                     // 11:30，不与 60 分钟维护冲突
    order("c1", -10, 50, "inProgress", { p: 130 }),
    order("p1", 5, 30),                       // 其它设备
  ],
};
const p1Before = state.orders.find((o) => o.equipmentId === "p1").scheduledStart;

// —— 09:00 压缩机上锁，计划 60 分钟 ——
const lock = startMaintenance(state, {
  equipmentId: "c1", reason: "更换滤芯", start: T0, plannedDurationMin: 60,
});
state = lock.state;

assert.equal(lock.rescheduled.length, 2, "两张冲突工单自动改约");
assert.equal(lock.paused.length, 1, "一张进行中工单暂停");
assert.equal(
  state.orders.find((o) => o.no === "F-2003").scheduledStart,
  T0 + 150 * MIN,
  "不冲突工单保持原时段",
);
assert.equal(state.orders.find((o) => o.equipmentId === "p1").scheduledStart, p1Before, "其它设备不动");
assert.equal(findScheduleConflict(state.orders, T0), null, "上锁后排班无同设备重叠");
const paused = state.orders.find((o) => o.status === "paused");
assert.equal(paused.currentPressureBar, 130, "现场压力保留 130bar");
assert.equal(paused.activePause.pressureAtPauseBar, 130);
// 维护自动改约计入总次数，但不计入客户改约次数
for (const o of lock.rescheduled) {
  assert.equal(o.rescheduleCount, 1);
  assert.equal(o.customerRescheduleCount, 0);
}

// —— 客户对一张工单连续改约 3 次 ——
const [ma] = lock.rescheduled.sort((a, b) => a.scheduledStart - b.scheduledStart);
({ state } = rescheduleOrder(state, ma.id, T0 + 4 * HOUR, T0, { name: "陈晨(新)", contact: "130-2222-3333" }));
({ state } = rescheduleOrder(state, ma.id, T0 + 5 * HOUR, T0, { name: "陈晨(新)", contact: "130-2222-3333" }));
const third = rescheduleOrder(state, ma.id, T0 + 6 * HOUR, T0, { name: "黑客名", contact: "139-9999-9999" });
state = third.state;
assert.equal(third.forcedFirstConfirm, true);
const tgt = state.orders.find((o) => o.id === ma.id);
assert.equal(tgt.customer.customerName, first.name, "第三次提交被拒绝，回写首次确认姓名");
assert.equal(tgt.customer.contact, first.phone, "回写首次确认联系方式");
assert.equal(tgt.customerRescheduleCount, 3);
assert.equal(findScheduleConflict(state.orders, T0), null, "客户改约后仍无重叠");

// —— 维护实际 100 分钟结束（超时 40 分钟）——
const fin = finishMaintenance(state, "c1", T0 + 100 * MIN);
state = fin.state;
assert.equal(fin.overrunMs, 40 * MIN);
assert.equal(fin.resumed.length, 1);
const resumed = state.orders.find((o) => o.status === "inProgress");
assert.equal(resumed.currentPressureBar, 130, "按暂停前 130bar 进度恢复");
assert.equal(resumed.pauseHistory[0].durationMs, 100 * MIN, "暂停时长 100 分钟");
assert.equal(findScheduleConflict(state.orders, T0), null, "解锁后排班无同设备重叠");

// 所有待充填工单避开实际维护窗口与恢复段（130→200 剩余约 23 分钟）
const mEnd = T0 + 100 * MIN;
const resumeRange = { start: mEnd, end: mEnd + 23 * MIN };
for (const o of state.orders.filter((o) => o.equipmentId === "c1" && o.status === "confirmed")) {
  const r = range(o.scheduledStart, o.scheduledDurationMin);
  assert.equal(overlap(r, { start: T0, end: mEnd }), false, `${o.no} 不压维护窗口`);
  assert.equal(overlap(r, resumeRange), false, `${o.no} 不压恢复段`);
}
// 超时顺延不改任何客户改约次数
assert.equal(
  state.orders.find((o) => o.id === ma.id).customerRescheduleCount,
  3,
);
// 维护锁已闭合、设备恢复
assert.equal(state.equipments[0].maintenance.actualEnd, mEnd);
assert.ok(state.audit.length >= 4, "审计留痕完整");

console.log("E2E 全部断言通过 ✓");
