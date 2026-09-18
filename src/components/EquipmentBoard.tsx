import { useState } from "react";
import type { Equipment } from "../types";
import {
  equipmentStatus,
  fmt,
  fmtDuration,
  finishMaintenance,
  startMaintenance,
} from "../domain";
import { getNow, getState, setState, useStore } from "../store";

const KIND_LABEL: Record<Equipment["kind"], string> = {
  compressor: "压缩机",
  fillPump: "充填泵",
};

const DURATIONS = [30, 60, 90, 120];

export default function EquipmentBoard() {
  const equipments = useStore((s) => s.equipments);
  const orders = useStore((s) => s.orders);
  const now = useStore((_s, t) => t);
  const [reason, setReason] = useState("计划保养");
  const [duration, setDuration] = useState(60);

  const enter = (eq: Equipment) => {
    try {
      const { state: next } = startMaintenance(getState(), {
        equipmentId: eq.id,
        reason,
        start: getNow(),
        plannedDurationMin: duration,
      });
      setState(next);
    } catch (e) {
      alert((e as Error).message);
    }
  };

  const exit = (eq: Equipment) => {
    try {
      const { state: next } = finishMaintenance(getState(), eq.id, getNow());
      setState(next);
    } catch (e) {
      alert((e as Error).message);
    }
  };

  return (
    <section className="panel">
      <div className="heading">
        <div>
          <p>充填台设备</p>
          <h2>设备维护锁</h2>
        </div>
        <div className="maintain-form">
          <label>
            <span>维护事由</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <label>
            <span>计划时长</span>
            <select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
              {DURATIONS.map((d) => (
                <option key={d} value={d}>
                  {d} 分钟
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="equip-grid">
        {equipments.map((eq) => {
          const st = equipmentStatus(eq, orders, now);
          const m = eq.maintenance;
          const pausedCount = orders.filter(
            (o) => o.equipmentId === eq.id && o.status === "paused",
          ).length;
          const waitCount = orders.filter(
            (o) => o.equipmentId === eq.id && o.status === "confirmed",
          ).length;
          return (
            <article key={eq.id} className={`equip-card status-${st.key}`}>
              <header>
                <div>
                  <h3>{eq.name}</h3>
                  <small>{KIND_LABEL[eq.kind]}</small>
                </div>
                <span className={`status-badge ${st.key}`}>{st.label}</span>
              </header>

              {m ? (
                <div className="maint-detail">
                  <p>
                    <b>{m.reason}</b>
                  </p>
                  <p>
                    开始 {fmt(m.start)} · 预计结束 {fmt(m.plannedEnd)}
                  </p>
                  {m.actualEnd === null ? (
                    <>
                      <p className={st.overrun ? "overrun" : ""}>
                        已锁定 {fmtDuration(Math.max(0, now - m.start))}
                        {st.overrun
                          ? ` · 已超出计划 ${fmtDuration(now - m.plannedEnd)}，解锁时受影响工单将自动顺延（不计改约次数）`
                          : ""}
                      </p>
                      <p className="muted">
                        {pausedCount} 单现场保留 · {waitCount} 单已改约等待
                      </p>
                      <button className="danger" onClick={() => exit(eq)}>
                        结束维护并恢复作业
                      </button>
                    </>
                  ) : (
                    <p className="muted">
                      实际结束 {fmt(m.actualEnd)}
                      {m.actualEnd > m.plannedEnd &&
                        `（超时 ${fmtDuration(m.actualEnd - m.plannedEnd)}）`}
                    </p>
                  )}
                </div>
              ) : (
                <div className="maint-detail">
                  <p className="muted">{st.detail}</p>
                  <button className="warning" onClick={() => enter(eq)}>
                    进入维护（上锁）
                  </button>
                </div>
              )}
            </article>
          );
        })}
      </div>

      <p className="rule-note">
        上锁瞬间：未开始工单自动改约到最近可用时段；进行中工单保留现场并记录暂停时长，解锁后按暂停前压力进度恢复。维护超时顺延不计入客户改约次数。
      </p>
    </section>
  );
}
