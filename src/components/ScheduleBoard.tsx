import { useMemo } from "react";
import type { Order } from "../types";
import { HOUR, MIN, overlap, range, remainingDurationMin } from "../domain";
import { useStore } from "../store";

const WINDOW_H = 12;

export default function ScheduleBoard() {
  const equipments = useStore((s) => s.equipments);
  const orders = useStore((s) => s.orders);
  const now = useStore((_s, t) => t);

  // 视图窗口：从当前整点开始 12 小时
  const winStart = Math.floor(now / HOUR) * HOUR;
  const winEnd = winStart + WINDOW_H * HOUR;

  const conflict = useMemo(() => {
    // 直接在组件中做同设备重叠校验，保证“刷新后的排班”可见即可信
    const byEquip = new Map<string, Order[]>();
    for (const o of orders) {
      if (o.status !== "confirmed") continue;
      const list = byEquip.get(o.equipmentId) ?? [];
      list.push(o);
      byEquip.set(o.equipmentId, list);
    }
    for (const list of byEquip.values()) {
      const s = [...list].sort((a, b) => a.scheduledStart - b.scheduledStart);
      for (let i = 1; i < s.length; i++) {
        const a = range(s[i - 1].scheduledStart, s[i - 1].scheduledDurationMin);
        const b = range(s[i].scheduledStart, s[i].scheduledDurationMin);
        if (overlap(a, b)) return s[i].no;
      }
    }
    return null;
  }, [orders]);

  const pos = (t: number) => {
    const pct = ((t - winStart) / (WINDOW_H * HOUR)) * 100;
    return Math.max(0, Math.min(100, pct));
  };
  const widthPct = (start: number, end: number) =>
    Math.max(0.4, ((end - start) / (WINDOW_H * HOUR)) * 100);

  const hourTicks = Array.from({ length: WINDOW_H + 1 }, (_, i) => winStart + i * HOUR);

  return (
    <section className="panel">
      <div className="heading">
        <div>
          <p>刷新后的排班</p>
          <h2>设备时段表</h2>
        </div>
        <span className={conflict ? "consistency-bad" : "consistency-ok"}>
          {conflict ? `⚠ 同设备时段重叠：${conflict}` : "✓ 同设备时段无重叠"}
        </span>
      </div>

      <div className="gantt-scroll">
        <div className="gantt" style={{ minWidth: 240 + WINDOW_H * 60 }}>
          <div className="gantt-row gantt-head">
            <div className="gantt-label" />
            <div className="gantt-track">
              {hourTicks.map((t, i) => (
                <span
                  key={t}
                  className="tick"
                  style={{ left: `${(i / WINDOW_H) * 100}%` }}
                >
                  {new Date(t).getHours().toString().padStart(2, "0")}:00
                </span>
              ))}
            </div>
          </div>

          {equipments.map((eq) => {
            const m = eq.maintenance;
            const showMaint =
              m && (m.actualEnd === null || m.actualEnd > winStart) && m.start < winEnd;
            return (
              <div className="gantt-row" key={eq.id}>
                <div className="gantt-label">
                  <b>{eq.name}</b>
                </div>
                <div className="gantt-track">
                  {hourTicks.map((t) => (
                    <i key={t} className="gridline" style={{ left: `${pos(t)}%` }} />
                  ))}
                  <i className="nowline" style={{ left: `${pos(now)}%` }} />

                  {showMaint && (
                    <div
                      className={`bar maintenance ${m.actualEnd === null ? "live" : ""}`}
                      style={{
                        left: `${pos(Math.max(m.start, winStart))}%`,
                        width: `${widthPct(Math.max(m.start, winStart), Math.min((m.actualEnd ?? now), winEnd))}%`,
                      }}
                      title={`维护：${m.reason}`}
                    >
                      维护{m.actualEnd === null ? "中" : "结束"}
                    </div>
                  )}

                  {orders
                    .filter((o) => o.equipmentId === eq.id)
                    .map((o) => {
                      if (o.status === "cancelled" || o.status === "signed") return null;
                      if (o.status === "confirmed") {
                        const r = range(o.scheduledStart, o.scheduledDurationMin);
                        if (r.end <= winStart || r.start >= winEnd) return null;
                        return (
                          <div
                            key={o.id}
                            className={`bar order confirmed rsch-${Math.min(o.rescheduleCount, 3)}`}
                            style={{
                              left: `${pos(Math.max(r.start, winStart))}%`,
                              width: `${widthPct(Math.max(r.start, winStart), Math.min(r.end, winEnd))}%`,
                            }}
                            title={`${o.no} · ${o.tank.tankNo}${o.rescheduleCount ? ` · 改约${o.rescheduleCount}次` : ""}`}
                          >
                            {o.no}
                            {o.rescheduleCount > 0 && <em>×{o.rescheduleCount}</em>}
                          </div>
                        );
                      }
                      if ((o.status === "inProgress" || o.status === "completed") && o.startedAt) {
                        const start = o.startedAt;
                        const end = o.startedAt + o.scheduledDurationMin * MIN;
                        if (end <= winStart || start >= winEnd) return null;
                        return (
                          <div
                            key={o.id}
                            className={`bar order ${o.status === "completed" ? "completed" : "running"}`}
                            style={{
                              left: `${pos(Math.max(start, winStart))}%`,
                              width: `${widthPct(Math.max(start, winStart), Math.min(end, winEnd))}%`,
                            }}
                            title={`${o.no} · ${o.status === "completed" ? "已完成" : "进行中"} ${o.currentPressureBar}bar`}
                          >
                            {o.no}
                          </div>
                        );
                      }
                      if (o.status === "paused" && o.activePause) {
                        const pStart = o.activePause.pausedAt;
                        // 维护已超时未结束时，恢复点至少为当前时刻
                        const resumeAt = Math.max(m?.plannedEnd ?? pStart, now);
                        const end = resumeAt + remainingDurationMin(o, resumeAt) * MIN;
                        return (
                          <div
                            key={o.id}
                            className="bar order paused"
                            style={{
                              left: `${pos(Math.max(pStart, winStart))}%`,
                              width: `${widthPct(Math.max(pStart, winStart), Math.min(end, winEnd))}%`,
                            }}
                            title={`${o.no} · 暂停保留现场 ${o.currentPressureBar}bar，维护结束恢复`}
                          >
                            {o.no} 暂停
                          </div>
                        );
                      }
                      return null;
                    })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="legend">
        <span><i className="lg confirmed" />已排班</span>
        <span><i className="lg rsch" />改约工单（角标为次数）</span>
        <span><i className="lg running" />进行中</span>
        <span><i className="lg paused" />暂停保留现场</span>
        <span><i className="lg maintenance" />维护锁</span>
        <span><i className="lg nowline" />当前时间</span>
      </div>
      <p className="muted small">视图随每次操作即时刷新；跨窗口工单时段以内部冲突校验为准。</p>
    </section>
  );
}
