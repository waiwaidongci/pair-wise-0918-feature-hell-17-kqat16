/* 工作流不变量测试（node 运行，esbuild 临时转译） */
import assert from "node:assert";
import { reducer } from "../src/store";
import {
  findConsistencyIssues,
  slotHasConflict,
  busyIntervals,
  findNearestSlot,
} from "../src/scheduling";
import type { AppState } from "../src/types";

const MIN = 60_000;
let state: AppState = reducer(undefined as unknown as AppState, { type: "RESET" });

function tick(min: number) {
  state = reducer(state, { type: "TICK", now: state.now + min * MIN });
}

function find(code: string) {
  const o = state.orders.find((x) => x.code === code);
  assert.ok(o, `缺少工单 ${code}`);
  return o!;
}

function assertConsistent(label: string) {
  const issues = findConsistencyIssues(state);
  assert.deepStrictEqual(
    issues.map((i) => i.message),
    [],
    `${label} 时三方应一致：${issues.map((i) => i.message).join("；")}`
  );
}

function assertNoOverlap(label: string) {
  for (const eq of state.equipment) {
    const intervals = busyIntervals(state.orders, state.maintenance, eq.id);
    for (let i = 1; i < intervals.length; i++) {
      assert.ok(
        intervals[i][0] >= intervals[i - 1][1],
        `${label}：${eq.id} 时段重叠 ${JSON.stringify(intervals)}`
      );
    }
    for (const o of state.orders.filter(
      (x) => x.equipmentId === eq.id && ["scheduled", "filling", "paused"].includes(x.status)
    )) {
      assert.ok(
        !slotHasConflict(state, eq.id, o.start, o.end, o.id) || o.status === "paused",
        `${label}：工单 ${o.code} 与同设备时段重叠`
      );
    }
  }
}

// ---- 初始一致 ----
assertConsistent("初始");
assertNoOverlap("初始");
const cp1 = "CP-01";

// ---- 用例 1：CP-01 进入维护 60 分钟 ----
// WO-1003 正在 CP-01 充填（进度 20/45 ≈ 44%）；WO-1001 / WO-1002 已排期
const w1003 = find("WO-1003");
const progressBefore = w1003.progressBase + (state.now - w1003.progressSince!) / (w1003.durationMin * MIN);
assert.ok(w1003.status === "filling", "WO-1003 初始应为 filling");

state = reducer(state, {
  type: "ENTER_MAINTENANCE",
  equipmentId: cp1,
  reason: "更换进气滤芯",
  durationMin: 100,
});
const maint = state.maintenance.find((m) => m.equipmentId === cp1 && m.end === null)!;
assert.ok(maint, "应存在进行中的维护锁");

// 已开始的工单：保留现场
const p1003 = find("WO-1003");
assert.strictEqual(p1003.status, "paused", "进行中的工单应暂停");
assert.strictEqual(p1003.maintenanceId, maint.id);
assert.ok(Math.abs(p1003.progressBase - progressBefore) < 0.01, "暂停前进度应被冻结记录");
assert.deepStrictEqual(maint.pausedOrderIds, [p1003.id], "维护记录应登记暂停工单");
assert.strictEqual(p1003.residualPressure, w1003.residualPressure, "现场压力保持不动");
assert.strictEqual(p1003.targetPressure, w1003.targetPressure);
assert.strictEqual(p1003.o2, w1003.o2);
assert.strictEqual(p1003.he, w1003.he);

// 未开始的工单：自动改约，且不与维护窗口/其他工单重叠
const moved = maint.rescheduledOrderIds.length;
assert.ok(moved >= 2, `WO-1001/WO-1002 应被自动改约，实际 ${moved}`);
for (const o of state.orders.filter((o) => maint.rescheduledOrderIds.includes(o.id))) {
  assert.ok(o.start >= maint.expectedEnd || o.end <= maint.start,
    `${o.code} 改约后不应与维护窗口重叠`);
  assert.strictEqual(o.rescheduleCount, 1, `${o.code} 应记为第 1 次改约`);
  assert.ok(!o.rescheduleLocked, "第 1 次改约不应锁定");
  assert.ok(
    !slotHasConflict(state, cp1, o.start, o.end, o.id),
    `${o.code} 改约后不能与同设备时段重叠`
  );
}
assertConsistent("维护中");
assertNoOverlap("维护中");

// ---- 用例 2：维护结束（按预计时间），暂停工单按进度恢复 ----
tick(100); // 到达预计解锁时刻
state = reducer(state, { type: "END_MAINTENANCE", maintenanceId: maint.id });
const r1003 = find("WO-1003");
assert.strictEqual(r1003.status, "filling", "维护结束后应恢复充填");
assert.ok(Math.abs(r1003.progressBase - progressBefore) < 0.01, "恢复后沿用暂停前进度");
assert.ok(r1003.pauseMinutes >= 99 && r1003.pauseMinutes <= 100, `暂停时长应约 100 分钟，实际 ${r1003.pauseMinutes}`);
assert.ok(r1003.totalPauseMs >= 99 * MIN, "应累计暂停时长");
assert.ok(r1003.end >= w1003.end + 99 * MIN, "预计完成时间应顺延");
assert.strictEqual(r1003.residualPressure, w1003.residualPressure, "恢复后现场参数不变");
assertConsistent("恢复后");
assertNoOverlap("恢复后");

// 进度应从暂停点继续：快进剩余时长后完成
const remainMin = (1 - r1003.progressBase) * r1003.durationMin;
tick(remainMin + 1);
const c1003 = find("WO-1003");
assert.strictEqual(c1003.status, "completed", `剩余充填完成应自动待签收，实际 ${c1003.status}`);
assertConsistent("完成后");

// ---- 用例 3：再对 CP-02 上的工单做两次改约 → 锁定首次确认信息 ----
const w1005 = find("WO-1005");
assert.strictEqual(w1005.rescheduleCount, 2);
assert.ok(w1005.rescheduleLocked, "种子工单 WO-1005 已改约两次应锁定");
const snapshot = { ...w1005.confirmedInfo };

state = reducer(state, { type: "MANUAL_RESCHEDULE", orderId: w1005.id });
const locked = find("WO-1005");
assert.strictEqual(locked.rescheduleCount, 3, "仍可继续改约（排时间）");
assert.ok(locked.rescheduleLocked, "锁定标记保持");
assert.strictEqual(locked.contactName, snapshot.contactName, "沿用首次确认姓名");
assert.strictEqual(locked.fillMethod, snapshot.fillMethod, "沿用首次确认方式");
assert.strictEqual(locked.o2, snapshot.o2, "沿用首次确认氧含量");
assert.strictEqual(locked.he, snapshot.he);
assert.strictEqual(locked.targetPressure, snapshot.targetPressure);
assert.strictEqual(locked.operator, snapshot.operator);
assert.ok(
  locked.events[locked.events.length - 1].message.includes("沿用客户首次确认信息"),
  "历史应记录沿用首次确认"
);
assertNoOverlap("第三次改约后");
assertConsistent("第三次改约后");

// ---- 用例 4：维护超时结束（晚于预计解锁），恢复后排班刷新、后续工单顺延无重叠 ----
state = reducer(state, {
  type: "ENTER_MAINTENANCE",
  equipmentId: "FP-01",
  reason: "密封件更换",
  durationMin: 30,
});
const m2 = state.maintenance.find((m) => m.equipmentId === "FP-01" && m.end === null)!;
// 晚 45 分钟解锁（超时 15 分钟）
state = reducer(state, { type: "TICK", now: m2.start + 75 * MIN });
state = reducer(state, { type: "END_MAINTENANCE", maintenanceId: m2.id });
assertConsistent("超时维护恢复后");
assertNoOverlap("超时维护恢复后");

// ---- 用例 5：最近可用时段查找不跨维护窗口 ----
const free = state.equipment[0].id;
const underMaint = state.maintenance.some((m) => m.equipmentId === free);
if (!underMaint) {
  // FP-01 刚解锁，其历史维护不应挡未来排程
  const slot = findNearestSlot(state, "FP-01", 30, state.now);
  assert.ok(slot.start >= state.now, "推荐时段不能在过去");
  assert.ok(
    !slotHasConflict(state, "FP-01", slot.start, slot.end),
    "推荐时段必须无冲突"
  );
}

console.log("全部工作流不变量测试通过 ✅");
