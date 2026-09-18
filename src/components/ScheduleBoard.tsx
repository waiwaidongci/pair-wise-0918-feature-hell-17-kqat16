import { useMemo } from "react";
import { useStore, fmtTimeShort, fmtDuration } from "../store";
import type { AppState, MaintenanceWindow, Order } from "../types";
import { busyIntervals, orderBusyInterval } from "../scheduling";

const STATUS_TEXT: Record<Order["status"], string> = {
  scheduled: "已排期",
  filling: "充填中",
  paused: "维护暂停",
  completed: "已完成",
  cancelled: "已取消",
};

/** 暂停/在职工单在时间轴上的占用终点 */
function intervalEnd(state: AppState, order: Order): number {
  if (order.status === "paused" && order.maintenanceId) {
    const m = state.maintenance.find((x) => x.id === order.maintenanceId);
    return orderBusyInterval(order, m?.expectedEnd)![1];
  }
  return order.end;
}

function EquipmentLane({
  equipmentId,
  windowStart,
  windowEnd,
}: {
  equipmentId: string;
  windowStart: number;
  windowEnd: number;
}) {
  const { state } = useStore();
  const equipment = state.equipment.find((e) => e.id === equipmentId)!;
  const span = windowEnd - windowStart;
  const pct = (ts: number) =>
    `${Math.max(0, Math.min(100, ((ts - windowStart) / span) * 100))}%`;

  const activeOrders = state.orders.filter(
    (o) =>
      o.equipmentId === equipmentId &&
      ["scheduled", "filling", "paused"].includes(o.status)
  );
  const maints = state.maintenance.filter(
    (m) => m.equipmentId === equipmentId && m.end === null
  );
  const busy = busyIntervals(state.orders, state.maintenance, equipmentId);

  return (
    <div className="lane">
      <div className="lane-title">
        <strong>{equipment.name}</strong>
        <span>{equipment.id}</span>
        {busy.length === 0 && <em className="lane-free">全天空闲</em>}
      </div>
      <div className="lane-track">
        <div className="lane-now" style={{ left: pct(state.now) }} title="当前时刻" />
        {maints.map((m: MaintenanceWindow) => (
          <div
            key={m.id}
            className="block block-maint"
            style={{ left: pct(m.start), width: pct(m.expectedEnd) }}
            title={`维护：${m.reason} ${fmtTimeShort(m.start)}–${fmtTimeShort(m.expectedEnd)}`}
          >
            🔒 维护 {fmtTimeShort(m.start)}–{fmtTimeShort(m.expectedEnd)}
          </div>
        ))}
        {activeOrders.map((o) => {
          const end = intervalEnd(state, o);
          return (
            <div
              key={o.id}
              className={`block block-${o.status}`}
              style={{ left: pct(o.start), width: pct(end) }}
              title={`${o.code} ${o.tankNo} ${STATUS_TEXT[o.status]} ${fmtTimeShort(
                o.start
              )}–${fmtTimeShort(end)}`}
            >
              {o.code} · {STATUS_TEXT[o.status]}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function ScheduleBoard() {
  const { state } = useStore();

  // 时间轴窗口：now-30min 到未来最后一个忙区间结束（至少 +6h）
  const { windowStart, windowEnd } = useMemo(() => {
    const start = state.now - 30 * 60_000;
    let end = state.now + 6 * 3600_000;
    for (const eq of state.equipment) {
      for (const [, e] of busyIntervals(state.orders, state.maintenance, eq.id)) {
        if (e > end) end = e;
      }
    }
    return { windowStart: start, windowEnd: end + 15 * 60_000 };
  }, [state]);

  const hours = useMemo(() => {
    const ticks: number[] = [];
    const step = 60 * 60_000;
    const first = Math.ceil(windowStart / step) * step;
    for (let t = first; t <= windowEnd; t += step) ticks.push(t);
    return ticks;
  }, [windowStart, windowEnd]);

  return (
    <section className="panel">
      <div className="heading">
        <div>
          <p>刷新后的排班</p>
          <h2>设备排班时间轴</h2>
        </div>
        <span className="muted">
          时间轴跨度 {fmtDuration(windowEnd - windowStart)} · 维护结束后自动刷新
        </span>
      </div>
      <div className="timeline">
        <div className="timeline-scale">
          <span style={{ width: 130 }} />
          <div className="timeline-track">
            {hours.map((t) => (
              <em
                key={t}
                style={{
                  position: "absolute",
                  left: `${((t - windowStart) / (windowEnd - windowStart)) * 100}%`,
                }}
              >
                {fmtTimeShort(t)}
              </em>
            ))}
          </div>
        </div>
        {state.equipment.map((eq) => (
          <EquipmentLane
            key={eq.id}
            equipmentId={eq.id}
            windowStart={windowStart}
            windowEnd={windowEnd}
          />
        ))}
      </div>
      <div className="legend">
        <span><i className="dot dot-scheduled" />已排期</span>
        <span><i className="dot dot-filling" />充填中</span>
        <span><i className="dot dot-paused" />维护暂停（现场保留）</span>
        <span><i className="dot dot-maint" />维护锁窗口</span>
        <span><i className="dot dot-now" />当前时刻</span>
      </div>
    </section>
  );
}
