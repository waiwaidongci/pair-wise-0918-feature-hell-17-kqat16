import { useState } from "react";
import { useStore, fmtTime, fmtDuration, equipmentDerivedStatus } from "../store";
import type { Equipment } from "../types";

const STATUS_LABEL: Record<string, string> = {
  idle: "空闲可用",
  filling: "充填作业中",
  maintenance: "维护锁定",
};

function MaintenanceForm({ equipment }: { equipment: Equipment }) {
  const { dispatch } = useStore();
  const [reason, setReason] = useState("");
  const [duration, setDuration] = useState("60");

  return (
    <div className="maint-form">
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="维护原因，如：更换滤芯 / 阀门检修"
      />
      <div className="maint-form-row">
        <label>
          <span>预计时长（分钟）</span>
          <input
            type="number"
            min={5}
            step={5}
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
          />
        </label>
        <button
          className="danger"
          onClick={() => {
            const mins = Number(duration);
            if (!Number.isFinite(mins) || mins < 5) return;
            dispatch({
              type: "ENTER_MAINTENANCE",
              equipmentId: equipment.id,
              reason: reason || "例行维护",
              durationMin: mins,
            });
            setReason("");
          }}
        >
          启动维护锁
        </button>
      </div>
      <p className="hint">
        上锁瞬间：未开始且与维护时段重叠的工单自动改约到最近可用时段；已开始的工单保留现场并按暂停前进度挂起。
      </p>
    </div>
  );
}

function EquipmentCard({ equipment }: { equipment: Equipment }) {
  const { state, dispatch } = useStore();
  const status = equipmentDerivedStatus(equipment.id, state);
  const activeMaint = state.maintenance.find(
    (m) => m.equipmentId === equipment.id && m.end === null
  );
  const paused = state.orders.filter(
    (o) => o.equipmentId === equipment.id && o.status === "paused"
  );
  const filling = state.orders.filter(
    (o) => o.equipmentId === equipment.id && o.status === "filling"
  );
  const scheduledCount = state.orders.filter(
    (o) => o.equipmentId === equipment.id && o.status === "scheduled"
  ).length;

  return (
    <article className={`equipment-card status-${status}`}>
      <div className="equipment-head">
        <div>
          <h3>{equipment.name}</h3>
          <p className="sub">
            {equipment.id} · {equipment.model} ·{" "}
            {equipment.kind === "compressor" ? "压缩机" : "充填泵"}
          </p>
        </div>
        <span className={`status-badge badge-${status}`}>{STATUS_LABEL[status]}</span>
      </div>

      {activeMaint ? (
        <div className="maint-active">
          <div className="maint-reason">🔒 {activeMaint.reason}</div>
          <dl className="maint-grid">
            <div>
              <dt>上锁时间</dt>
              <dd>{fmtTime(activeMaint.start)}</dd>
            </div>
            <div>
              <dt>预计解锁</dt>
              <dd>{fmtTime(activeMaint.expectedEnd)}</dd>
            </div>
            <div>
              <dt>已持续</dt>
              <dd>{fmtDuration(state.now - activeMaint.start)}</dd>
            </div>
            <div>
              <dt>现场暂停</dt>
              <dd>{activeMaint.pausedOrderIds.length} 单</dd>
            </div>
            <div>
              <dt>自动改约</dt>
              <dd>{activeMaint.rescheduledOrderIds.length} 单</dd>
            </div>
          </dl>
          {paused.length > 0 && (
            <p className="hint">
              现场保留：{paused.map((o) => o.code).join("、")}（压力与配比未动，解锁后按暂停前进度恢复）
            </p>
          )}
          <button
            className="primary"
            onClick={() =>
              dispatch({ type: "END_MAINTENANCE", maintenanceId: activeMaint.id })
            }
          >
            维护结束 · 解除维护锁并恢复排班
          </button>
          <p className="hint">
            可提前或延后解锁：系统按实际时间记录暂停时长，恢复后自动刷新排班、顺延冲突工单。
          </p>
        </div>
      ) : (
        <>
          <div className="equipment-meta">
            <span>充填中 {filling.length}</span>
            <span>待充填 {scheduledCount}</span>
          </div>
          <MaintenanceForm equipment={equipment} />
        </>
      )}
    </article>
  );
}

export default function EquipmentBoard() {
  const { state } = useStore();
  return (
    <section className="panel">
      <div className="heading">
        <div>
          <p>设备维护锁</p>
          <h2>充填台设备</h2>
        </div>
      </div>
      <div className="equipment-grid">
        {state.equipment.map((eq) => (
          <EquipmentCard key={eq.id} equipment={eq} />
        ))}
      </div>
    </section>
  );
}
